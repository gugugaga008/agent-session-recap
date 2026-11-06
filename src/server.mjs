// Lightweight local web UI: a tiny http server (no framework) that serves a
// static single page plus a few JSON endpoints. Binds to 127.0.0.1 by default.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
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
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) reject(new Error("请求体过大"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
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

export function createServer(opts = {}) {
  const sessionsDir = getSessionsDir(opts.sessionDir);
  const cache = new ScanCache();
  const lastScan = new Map(); // id -> meta (latest scan)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/api/config") {
        return sendJson(res, 200, {
          sessionsDir,
          defaultOutDir: getDefaultExportDir(),
          defaultField: DEFAULT_FIELD,
          fields: TIME_FIELDS,
          formats: EXPORT_FORMATS,
        });
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
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
        return sendJson(res, 200, {
          sessionsDir,
          scanned: all.length,
          count: list.length,
          sessions: list,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/pick-dir") {
        const body = JSON.parse((await readBody(req)) || "{}");
        const picked = await pickDirectory(body.initial);
        return sendJson(res, 200, { path: picked });
      }

      if (req.method === "POST" && url.pathname === "/api/export") {
        const body = JSON.parse((await readBody(req)) || "{}");
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

      if (req.method === "GET") return serveStatic(res, url.pathname);

      res.writeHead(405);
      res.end("方法不允许");
    } catch (e) {
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
