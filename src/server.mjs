// Lightweight local web UI: a tiny http server (no framework) that serves a
// static single page plus JSON endpoints — session listing/filtering, export,
// provider management, and the AI features (summarize / batch / ask).
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSessionsDir, getDefaultExportDir } from "./paths.mjs";
import { collectSessionFiles } from "./scanner.mjs";
import { scanMeta } from "./parser.mjs";
import { filterSessions, resolveRange, DEFAULT_FIELD, TIME_FIELDS } from "./filter.mjs";
import { exportMany, EXPORT_FORMATS } from "./export.mjs";
import {
  API_KINDS,
  PRESET_GROUPS,
  addProvider,
  detectProtocol,
  fetchModels,
  getProvider,
  listProviders,
  loadPrefs,
  loadPresets,
  removeProvider,
  savePrefs,
  updateProvider,
} from "./providers.mjs";
import { askSessions, complete, summarizeBatch, summarizeSession } from "./ai.mjs";
import { enrichModels } from "./modelinfo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/** Metadata cache keyed by absolute path; invalidated by size+mtime change. */
class ScanCache {
  constructor() {
    this.map = new Map();
  }
  async scanAll(sessionsDir) {
    const files = await collectSessionFiles(sessionsDir);
    const out = [];
    for (const file of files) {
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      const cached = this.map.get(file);
      if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) {
        out.push(cached.meta);
        continue;
      }
      const meta = await scanMeta(file);
      if (!meta) continue;
      this.map.set(file, { size: stat.size, mtime: stat.mtimeMs, meta });
      out.push(meta);
    }
    // prune deleted files
    const live = new Set(files);
    for (const k of [...this.map.keys()]) if (!live.has(k)) this.map.delete(k);
    return out;
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("禁止访问");
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("未找到");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20_000_000) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    // decode once, so a multi-byte character split across chunks is not mangled
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("请求体不是合法 JSON");
  }
}

/** 在本机弹出原生文件夹选择对话框，返回所选目录的绝对路径（取消返回 null）。 */
function pickDirectory(initial) {
  return new Promise((resolve) => {
    const opts = { timeout: 300000, windowsHide: true };
    if (process.platform === "win32") {
      const safe = String(initial || "").replace(/'/g, "''");
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$f=New-Object System.Windows.Forms.FolderBrowserDialog",
        "$f.Description='选择导出目录'",
        "$f.ShowNewFolderButton=$true",
        safe ? `$f.SelectedPath='${safe}'` : "",
        "if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($f.SelectedPath)}",
      ]
        .filter(Boolean)
        .join("; ");
      execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", ps], opts, (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).trim() || null);
      });
      return;
    }
    if (process.platform === "darwin") {
      execFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "选择导出目录")'], opts, (err, stdout) => {
        resolve(err ? null : String(stdout).trim() || null);
      });
      return;
    }
    execFile("zenity", ["--file-selection", "--directory", "--title=选择导出目录"], opts, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

/** Server-sent events: one JSON object per `data:` line. */
function openSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  let open = true;
  res.on("close", () => {
    open = false;
  });
  return {
    get open() {
      return open;
    },
    send(obj) {
      if (!open) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    end() {
      if (!open) return;
      open = false;
      res.end();
    },
  };
}

/**
 * A provider for an ad-hoc call: the form's own endpoints/key when it sent
 * any (so a test uses exactly what is on screen), else the saved one by id.
 * The id is kept so results can still be saved back.
 */
function providerFromBody(body) {
  const hasConn = !!(body.chat || body.responses || body.anthropic || body.gemini);
  if (hasConn) return { ...body, id: body.id || "__adhoc__" };
  return body.id ? getProvider(body.id) : null;
}

export function createServer(opts = {}) {
  const sessionsDir = getSessionsDir(opts.sessionDir);
  const cache = new ScanCache();
  const lastScan = new Map(); // id -> meta (latest scan)

  async function ensureSessions(ids) {
    let missing = ids.filter((id) => !lastScan.has(id));
    if (missing.length) {
      const all = await cache.scanAll(sessionsDir);
      for (const m of all) lastScan.set(m.id, m);
      missing = ids.filter((id) => !lastScan.has(id));
    }
    return { list: ids.map((id) => lastScan.get(id)).filter(Boolean), missing };
  }

  async function resolveProvider(body) {
    if (body.providerId) {
      const p = getProvider(body.providerId);
      if (!p) throw new Error(`未找到供应商「${body.providerId}」`);
      return p;
    }
    if (body.provider && typeof body.provider === "object") return body.provider;
    throw new Error("请选择供应商");
  }

  function defaultModelFor(provider, body) {
    const model = body.model || loadPrefs().defaultModel;
    if (model) return model;
    const first = (provider.models && provider.models[0]) || (provider.pickedFrom && provider.pickedFrom[0]);
    if (first) return first;
    throw new Error("请选择模型");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/api/config") {
        return sendJson(res, 200, {
          sessionsDir,
          defaultOutDir: getDefaultExportDir(),
          defaultField: DEFAULT_FIELD,
          fields: TIME_FIELDS,
          formats: EXPORT_FORMATS,
          apiKinds: API_KINDS,
          presetGroups: PRESET_GROUPS,
        });
      }

      if (req.method === "GET" && p === "/api/sessions") {
        const q = url.searchParams;
        const { from, to } = resolveRange(q.get("from"), q.get("to"));
        const all = await cache.scanAll(sessionsDir);
        for (const m of all) lastScan.set(m.id, m);
        const list = filterSessions(all, {
          field: q.get("field") || DEFAULT_FIELD,
          from,
          to,
          includeArchived: q.get("includeArchived") === "1" || q.get("includeArchived") === "true",
          cwd: q.get("cwd") || null,
          grep: q.get("grep") || null,
        });
        return sendJson(res, 200, { sessionsDir, scanned: all.length, count: list.length, sessions: list });
      }

      if (req.method === "POST" && p === "/api/pick-dir") {
        const body = await readJsonBody(req);
        const picked = await pickDirectory(body.initial);
        return sendJson(res, 200, { path: picked });
      }

      if (req.method === "POST" && p === "/api/export") {
        const body = await readJsonBody(req);
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const format = body.format || "jsonl";
        const outDir = body.outDir;
        if (!EXPORT_FORMATS.includes(format)) return sendJson(res, 400, { error: "格式不合法" });
        if (!outDir) return sendJson(res, 400, { error: "缺少 outDir" });
        const list = ids.map((id) => lastScan.get(id)).filter(Boolean);
        if (!list.length) return sendJson(res, 400, { error: "未选择有效会话" });
        const result = await exportMany(list, format, outDir);
        return sendJson(res, 200, result);
      }

      // ---------------------------------------------------------- providers

      if (req.method === "GET" && p === "/api/providers") {
        return sendJson(res, 200, {
          providers: listProviders({ reveal: url.searchParams.get("reveal") === "1" }),
          presets: loadPresets(),
          groups: PRESET_GROUPS,
          apiKinds: API_KINDS,
          prefs: loadPrefs(),
        });
      }

      if (req.method === "POST" && p === "/api/providers") {
        const body = await readJsonBody(req);
        const created = await addProvider(body);
        if (body.setDefault) await savePrefs({ defaultProvider: created.id });
        return sendJson(res, 200, { provider: created });
      }

      if (req.method === "POST" && p === "/api/providers/models") {
        const body = await readJsonBody(req);
        const provider = providerFromBody(body);
        if (!provider) return sendJson(res, 404, { error: "未找到供应商" });
        const wanted = Array.isArray(body.models) && body.models.length ? body.models : null;
        let models = wanted || [];
        let upstream = {};
        let errors = [];
        if (!wanted || body.refresh) {
          const r = await fetchModels(provider);
          models = wanted ? [...new Set([...wanted, ...r.models])] : r.models;
          upstream = r.upstream || {};
          errors = r.errors || [];
        }
        const existing = (provider.modelMeta && typeof provider.modelMeta === "object" && provider.modelMeta) || {};
        const { meta, catalog } = await enrichModels(provider, models, {
          upstream,
          force: !!body.force,
          existing,
        });
        if (provider.id && provider.id !== "__adhoc__" && Object.keys(meta).length) {
          try {
            await updateProvider(provider.id, { modelMeta: { ...existing, ...meta } });
          } catch {
            /* ignore */
          }
        }
        return sendJson(res, 200, { models, meta, catalog, errors });
      }

      // 测试连接：真发一次最小请求，报告耗时与结果
      if (req.method === "POST" && p === "/api/providers/check") {
        const body = await readJsonBody(req);
        const provider = providerFromBody(body);
        if (!provider) return sendJson(res, 404, { error: "未找到供应商" });
        const model = String(body.model || "").trim() || (provider.models && provider.models[0]) || "";
        if (!model) return sendJson(res, 200, { ok: false, error: "请先填写或选择一个模型" });
        const started = Date.now();
        try {
          const reply = await complete(provider, {
            model,
            messages: [{ role: "user", content: body.prompt || "Say OK." }],
            maxTokens: 16,
            temperature: 0,
            stream: false,
          });
          return sendJson(res, 200, {
            ok: true,
            model,
            latencyMs: Date.now() - started,
            reply: String(reply || "").slice(0, 500),
          });
        } catch (e) {
          return sendJson(res, 200, {
            ok: false,
            model,
            latencyMs: Date.now() - started,
            error: String((e && e.message) || e),
          });
        }
      }

      if (req.method === "POST" && p === "/api/providers/test") {
        const body = await readJsonBody(req);
        const result = await detectProtocol(body);
        return sendJson(res, 200, result);
      }

      if (req.method === "POST" && p === "/api/prefs") {
        const body = await readJsonBody(req);
        return sendJson(res, 200, { prefs: await savePrefs(body) });
      }

      const provMatch = /^\/api\/providers\/([^/]+)$/.exec(p);
      if (provMatch) {
        const id = decodeURIComponent(provMatch[1]);
        if (req.method === "PATCH" || req.method === "PUT") {
          const body = await readJsonBody(req);
          return sendJson(res, 200, { provider: await updateProvider(id, body) });
        }
        if (req.method === "DELETE") {
          return sendJson(res, 200, await removeProvider(id));
        }
      }

      // ---------------------------------------------------------- AI (SSE)

      if (req.method === "POST" && p === "/api/ai/summarize") {
        const body = await readJsonBody(req);
        const provider = await resolveProvider(body);
        const model = defaultModelFor(provider, body);
        const { list, missing } = await ensureSessions(body.ids || (body.id ? [body.id] : []));
        const sse = openSse(res);
        if (missing.length) sse.send({ type: "warning", message: `未找到会话：${missing.join(", ")}` });
        if (!list.length) {
          sse.send({ type: "error", message: "未选择有效会话" });
          return sse.end();
        }
        sse.send({ type: "start", provider: provider.id, model, count: list.length });
        for (const meta of list) {
          sse.send({ type: "session-start", id: meta.id, name: meta.displayName || meta.id });
          try {
            let text = "";
            for await (const d of summarizeSession(provider, model, meta, { lang: body.lang, maxChars: body.maxChars })) {
              if (!sse.open) return;
              text += d;
              sse.send({ type: "delta", id: meta.id, text: d });
            }
            sse.send({ type: "session-end", id: meta.id, text });
          } catch (e) {
            sse.send({ type: "error", id: meta.id, message: String(e && e.message ? e.message : e) });
          }
        }
        sse.send({ type: "done" });
        return sse.end();
      }

      if (req.method === "POST" && p === "/api/ai/summarize-batch") {
        const body = await readJsonBody(req);
        const provider = await resolveProvider(body);
        const model = defaultModelFor(provider, body);
        const { list, missing } = await ensureSessions(body.ids || []);
        const sse = openSse(res);
        if (missing.length) sse.send({ type: "warning", message: `未找到会话：${missing.join(", ")}` });
        if (!list.length) {
          sse.send({ type: "error", message: "未选择有效会话" });
          return sse.end();
        }
        sse.send({ type: "start", provider: provider.id, model, count: list.length });
        try {
          for await (const ev of summarizeBatch(provider, model, list, {
            lang: body.lang,
            range: body.range,
            maxChars: body.maxChars,
            concurrency: body.concurrency,
          })) {
            if (!sse.open) return;
            sse.send(ev);
          }
        } catch (e) {
          sse.send({ type: "error", message: String(e && e.message ? e.message : e) });
        }
        sse.send({ type: "done" });
        return sse.end();
      }

      if (req.method === "POST" && p === "/api/ai/chat") {
        const body = await readJsonBody(req);
        const provider = await resolveProvider(body);
        const model = defaultModelFor(provider, body);
        const question = String(body.question || "").trim();
        const sse = openSse(res);
        if (!question) {
          sse.send({ type: "error", message: "请输入问题" });
          return sse.end();
        }
        const { list, missing } = await ensureSessions(body.ids || []);
        if (missing.length) sse.send({ type: "warning", message: `未找到会话：${missing.join(", ")}` });
        if (!list.length) {
          sse.send({ type: "error", message: "没有可用于提问的会话，请先筛选会话" });
          return sse.end();
        }
        sse.send({ type: "start", provider: provider.id, model, count: list.length });
        try {
          for await (const ev of askSessions(provider, model, list, question, {
            history: Array.isArray(body.history) ? body.history : [],
            lang: body.lang,
            budget: body.budget,
            topK: body.topK,
          })) {
            if (!sse.open) return;
            sse.send(ev);
          }
        } catch (e) {
          sse.send({ type: "error", message: String(e && e.message ? e.message : e) });
        }
        sse.send({ type: "done" });
        return sse.end();
      }

      if (req.method === "GET") return serveStatic(res, p);

      res.writeHead(405);
      res.end("方法不允许");
    } catch (e) {
      if (res.headersSent) {
        try {
          res.write(`data: ${JSON.stringify({ type: "error", message: String(e && e.message ? e.message : e) })}\n\n`);
        } catch {
          /* ignore */
        }
        res.end();
        return;
      }
      sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  });

  return { server, sessionsDir };
}

export async function startServer(opts = {}) {
  const host = opts.host || "127.0.0.1";
  const port = opts.port || 8651;
  const { server, sessionsDir } = createServer(opts);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { server, host, port, sessionsDir };
}
