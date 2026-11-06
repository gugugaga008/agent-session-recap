// Export selected sessions. READ-ONLY on the source tree: JSONL is copied
// verbatim; Markdown and HTML are rendered from a fresh parse.
//
// Markdown granularity follows session-insight's exporter: per turn it emits
// the User and Assistant text, the tool NAMES, and token/duration — it does
// NOT emit thinking/reasoning or tool arguments/results.
import fs from "node:fs/promises";
import path from "node:path";
import { parseFull } from "./parser.mjs";
import { formatLocal } from "./time.mjs";

export const EXPORT_FORMATS = ["jsonl", "md", "html"];

function fmtDur(ms) {
  if (!ms) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function stem(file) {
  return path.basename(file).replace(/\.jsonl$/i, "");
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(parsed) {
  const { meta, turns } = parsed;
  const out = [];
  out.push(`# ${meta.displayName}`);
  out.push("");
  if (meta.cwd) out.push(`**工作目录：** ${meta.cwd}`);
  out.push(`**模型：** ${meta.model || "-"} | **轮次：** ${turns.length}`);
  out.push(
    `**创建时间：** ${formatLocal(meta.created)} | **最后活动：** ${formatLocal(meta.lastActivity)}`,
  );
  out.push("");
  out.push("---");
  out.push("");
  for (const t of turns) {
    out.push(`## 第 ${t.index + 1} 轮`);
    out.push("");
    if (t.user) {
      out.push(`**用户：** ${t.user}`);
      out.push("");
    }
    if (t.assistant) {
      out.push(`**助手：** ${t.assistant}`);
      out.push("");
    }
    if (t.tools.length) {
      out.push(`*工具：${t.tools.join(", ")}*`);
      out.push("");
    }
    out.push(`*${t.tokens} tokens | 耗时 ${fmtDur(t.durationMs)}*`);
    out.push("");
    out.push("---");
    out.push("");
  }
  return out.join("\n");
}

function renderHtml(parsed) {
  const { meta, turns } = parsed;
  const body = [];
  body.push(`<h1>${escapeHtml(meta.displayName)}</h1>`);
  body.push('<dl class="meta">');
  if (meta.cwd) body.push(`<dt>工作目录</dt><dd>${escapeHtml(meta.cwd)}</dd>`);
  body.push(`<dt>模型</dt><dd>${escapeHtml(meta.model || "-")}</dd>`);
  body.push(`<dt>轮次</dt><dd>${turns.length}</dd>`);
  body.push(`<dt>创建时间</dt><dd>${escapeHtml(formatLocal(meta.created))}</dd>`);
  body.push(`<dt>最后活动</dt><dd>${escapeHtml(formatLocal(meta.lastActivity))}</dd>`);
  body.push("</dl>");
  for (const t of turns) {
    body.push('<section class="turn">');
    body.push(`<h2>第 ${t.index + 1} 轮</h2>`);
    if (t.user) body.push(`<div class="msg user"><span class="who">用户</span><pre>${escapeHtml(t.user)}</pre></div>`);
    if (t.assistant)
      body.push(`<div class="msg assistant"><span class="who">助手</span><pre>${escapeHtml(t.assistant)}</pre></div>`);
    if (t.tools.length) body.push(`<div class="tools">工具：${escapeHtml(t.tools.join(", "))}</div>`);
    body.push(`<div class="stat">${t.tokens} tokens | 耗时 ${escapeHtml(fmtDur(t.durationMs))}</div>`);
    body.push("</section>");
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.displayName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 -apple-system, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.5rem; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .1rem .8rem; font-size: .9rem; opacity: .85; }
  dl.meta dt { font-weight: 600; }
  .turn { border-top: 1px solid #8884; margin-top: 1.4rem; padding-top: .6rem; }
  .turn h2 { font-size: 1rem; opacity: .7; }
  .msg { margin: .6rem 0; }
  .msg .who { font-weight: 700; font-size: .8rem; text-transform: uppercase; opacity: .6; }
  .msg pre { white-space: pre-wrap; word-wrap: break-word; margin: .2rem 0 0; font: inherit; background: #8881; padding: .6rem .8rem; border-radius: 8px; }
  .tools, .stat { font-size: .82rem; opacity: .7; }
</style>
</head>
<body>
${body.join("\n")}
</body>
</html>
`;
}

async function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  let n = 1;
  for (;;) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base}-${n}${ext}`);
      n++;
    } catch {
      return candidate;
    }
  }
}

/**
 * Export one session.
 * @returns {Promise<{src:string,dest:string,format:string,bytes:number}>}
 */
export async function exportOne(meta, format, outDir) {
  if (!EXPORT_FORMATS.includes(format)) throw new Error(`Unsupported format: ${format}`);
  await fs.mkdir(outDir, { recursive: true });
  const s = stem(meta.path);
  if (format === "jsonl") {
    const dest = await uniquePath(outDir, `${s}.jsonl`);
    await fs.copyFile(meta.path, dest);
    const st = await fs.stat(dest);
    return { src: meta.path, dest, format, bytes: st.size };
  }
  const parsed = await parseFull(meta.path);
  if (!parsed) throw new Error(`Cannot read session: ${meta.path}`);
  const content = format === "md" ? renderMarkdown(parsed) : renderHtml(parsed);
  const ext = format === "md" ? ".md" : ".html";
  const dest = await uniquePath(outDir, `${s}${ext}`);
  await fs.writeFile(dest, content, "utf8");
  return { src: meta.path, dest, format, bytes: Buffer.byteLength(content, "utf8") };
}

/**
 * Export many sessions; writes a manifest.json alongside the exports.
 * @returns {Promise<{out:string,count:number,items:Array,failures:Array}>}
 */
export async function exportMany(list, format, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const items = [];
  const failures = [];
  for (const meta of list) {
    try {
      items.push(await exportOne(meta, format, outDir));
    } catch (e) {
      failures.push({ src: meta.path, error: String(e && e.message ? e.message : e) });
    }
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    format,
    outDir,
    count: items.length,
    failures,
    items,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { out: outDir, count: items.length, items, failures, manifestPath };
}
