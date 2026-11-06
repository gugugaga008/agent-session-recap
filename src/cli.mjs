// CLI：list / web / export 三个命令，基于共享核心的薄封装。
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { getSessionsDir, getDefaultExportDir } from "./paths.mjs";
import { collectSessionFiles } from "./scanner.mjs";
import { scanMeta } from "./parser.mjs";
import { filterSessions, resolveRange, DEFAULT_FIELD, TIME_FIELDS } from "./filter.mjs";
import { renderTable, renderJson, renderCsv } from "./report.mjs";
import { exportMany, EXPORT_FORMATS } from "./export.mjs";
import { startServer } from "./server.mjs";

const OPTIONS = {
  field: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  "include-archived": { type: "boolean" },
  cwd: { type: "string" },
  grep: { type: "string" },
  json: { type: "boolean" },
  csv: { type: "boolean" },
  save: { type: "string" },
  limit: { type: "string" },
  "session-dir": { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  open: { type: "boolean" },
  format: { type: "string" },
  out: { type: "string" },
  result: { type: "string" },
  ids: { type: "string" },
  help: { type: "boolean", short: "h" },
};

function help() {
  return `agent-session-recap — AI 编码 agent 会话只读浏览 / 时间段筛选 / 导出工具

用法：
  agent-session-recap list   [筛选] [--json|--csv] [--save <文件>]
  agent-session-recap web    [--port 8651] [--host 127.0.0.1] [--open]
  agent-session-recap export [筛选 | --result <文件>] [--ids a,b] --format jsonl|md|html --out <目录>

AI（在 web 界面里）：
  总结单条会话 / 对筛选结果做摘要总结 / 针对筛选结果 AI 提问。
  先在网页右上角「AI 供应商」里添加供应商（配置与 magpie 一致）。

筛选：
  --field <名称>        created(创建) | lastActivity(最后活动) | lastMessage(最后消息) | mtime(文件更新) | activity(区间内有活动)   （默认：${DEFAULT_FIELD}）
  --from <时间>         起始时间（含），本地时区。例：2026-11-05 或 "2026-11-05 08:00"
  --to <时间>           结束时间（不含），本地时区。例：2026-11-06
  --include-archived    同时扫描 .pideck-archive 归档
  --cwd <通配符>        匹配工作目录，例："*\\\\项目\\\\*"
  --grep <关键词>       匹配 名称 / 预览 / 工作目录 / 会话 ID

其它：
  --session-dir <目录>  覆盖 sessions 根目录
  --limit <n>           限制列出条数
  --save <文件>         把筛选结果写入 JSON 文件
  --result <文件>       导出 --save 记录中的会话
  --ids <a,b,c>         仅导出这些会话 ID
  --out <目录>          导出目录（默认：下载文件夹）
  -h, --help            显示本帮助

时间区间为半开区间 [from, to)。只给日期时按本地 0 点处理。
源会话永不被修改——导出只是复制出去。
`;
}

async function scanAll(sessionsDir) {
  const files = await collectSessionFiles(sessionsDir);
  const out = [];
  for (const file of files) {
    const meta = await scanMeta(file);
    if (meta) out.push(meta);
  }
  return out;
}

function applyLimit(list, limit) {
  if (!limit) return list;
  const n = Number(limit);
  return Number.isFinite(n) && n >= 0 ? list.slice(0, n) : list;
}

function filterOpts(values) {
  const { from, to } = resolveRange(values.from, values.to);
  if (values.field && !TIME_FIELDS.includes(values.field)) {
    throw new Error(`无效的 --field "${values.field}"。可选：${TIME_FIELDS.join(", ")}`);
  }
  return {
    field: values.field || DEFAULT_FIELD,
    from,
    to,
    includeArchived: !!values["include-archived"],
    cwd: values.cwd || null,
    grep: values.grep || null,
  };
}

async function cmdList(values, sessionsDir) {
  const opts = filterOpts(values);
  const all = await scanAll(sessionsDir);
  let list = filterSessions(all, opts);
  list = applyLimit(list, values.limit);
  if (values.save) {
    await fs.writeFile(values.save, renderJson(list), "utf8");
    process.stderr.write(`已保存 ${list.length} 个会话到 ${values.save}\n`);
  }
  if (values.json) process.stdout.write(renderJson(list) + "\n");
  else if (values.csv) process.stdout.write(renderCsv(list) + "\n");
  else {
    process.stdout.write(
      `会话目录：${sessionsDir}\n扫描 ${all.length} 个 · 匹配 ${list.length} 个（字段=${opts.field}）\n\n`,
    );
    process.stdout.write(renderTable(list) + "\n");
  }
}

async function loadListForExport(values, sessionsDir) {
  if (values.result) {
    const raw = await fs.readFile(values.result, "utf8");
    let list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error("--result 文件不是会话数组");
    if (values.ids) {
      const ids = new Set(values.ids.split(",").map((s) => s.trim()).filter(Boolean));
      list = list.filter((s) => ids.has(s.id));
    }
    return applyLimit(list, values.limit);
  }
  const opts = filterOpts(values);
  const all = await scanAll(sessionsDir);
  let list = filterSessions(all, opts);
  if (values.ids) {
    const ids = new Set(values.ids.split(",").map((s) => s.trim()).filter(Boolean));
    list = list.filter((s) => ids.has(s.id));
  }
  return applyLimit(list, values.limit);
}

async function cmdExport(values, sessionsDir) {
  const format = values.format || "jsonl";
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error(`无效的 --format "${format}"。可选：${EXPORT_FORMATS.join(", ")}`);
  }
  const outDir = path.resolve(values.out || getDefaultExportDir());
  const list = await loadListForExport(values, sessionsDir);
  if (!list.length) {
    process.stderr.write("没有匹配的会话——无可导出。\n");
    return;
  }
  const res = await exportMany(list, format, outDir);
  process.stdout.write(
    `已导出 ${res.count} 个文件（格式 ${format}）到 ${outDir}\n清单：${res.manifestPath}\n`,
  );
  if (res.failures.length) {
    process.stderr.write(`失败 ${res.failures.length} 个：\n`);
    for (const f of res.failures) process.stderr.write(`  ${f.src} — ${f.error}\n`);
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* 忽略 */
  }
}

async function cmdWeb(values, sessionsDir) {
  const port = Number(values.port) || 8651;
  const host = values.host || "127.0.0.1";
  const { server, sessionsDir: dir } = await startServer({ port, host, sessionDir: values["session-dir"] });
  const url = `http://${host}:${port}`;
  process.stdout.write(`agent-session-recap 网页界面已启动：${url}\n会话目录：${dir}\n按 Ctrl+C 停止。\n`);
  if (values.open) openBrowser(url);
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    process.stderr.write(String(e.message) + "\n\n" + help());
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0] || "help";

  if (values.help || command === "help") {
    process.stdout.write(help());
    return 0;
  }

  const sessionsDir = getSessionsDir(values["session-dir"]);

  try {
    switch (command) {
      case "list":
        await cmdList(values, sessionsDir);
        return 0;
      case "web":
        await cmdWeb(values, sessionsDir);
        return 0;
      case "export":
        await cmdExport(values, sessionsDir);
        return 0;
      default:
        process.stderr.write(`未知命令 "${command}"。\n\n` + help());
        return 2;
    }
  } catch (e) {
    process.stderr.write(`错误：${e && e.message ? e.message : e}\n`);
    return 1;
  }
}
