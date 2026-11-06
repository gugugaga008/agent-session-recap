// CLI 输出格式化：表格 / JSON / CSV。无依赖。
// 中文按双宽计算，保证表格对齐。
import { formatLocal } from "./time.mjs";

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += isWide(ch.codePointAt(0)) ? 2 : 1;
  return w;
}

function padTo(s, width) {
  s = String(s == null ? "" : s);
  const w = dispWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

function truncate(s, width) {
  s = s == null ? "" : String(s);
  if (dispWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0)) ? 2 : 1;
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + "\u2026";
}

function fmtSize(bytes) {
  if (bytes == null) return "-";
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}K`;
  return `${(kb / 1024).toFixed(1)}M`;
}

const COLUMNS = [
  { title: "工作目录", width: 34, get: (s) => truncate(s.cwd || "-", 34) },
  { title: "会话名称", width: 24, get: (s) => truncate(s.displayName || s.name || s.preview || "-", 24) },
  { title: "会话 ID", width: 10, get: (s) => truncate(s.id, 10) },
  { title: "创建时间", width: 19, get: (s) => formatLocal(s.created) },
  { title: "最后消息", width: 19, get: (s) => formatLocal(s.lastMessage) },
  { title: "最后活动", width: 19, get: (s) => formatLocal(s.lastActivity) },
  { title: "文件更新时间", width: 19, get: (s) => formatLocal(s.mtime) },
  { title: "大小", width: 7, get: (s) => fmtSize(s.size) },
  { title: "归档", width: 4, get: (s) => (s.archived ? "是" : "") },
];

export function renderTable(list) {
  if (!list.length) return "（没有匹配的会话）";
  const header = COLUMNS.map((c) => padTo(c.title, c.width)).join("  ");
  const sep = COLUMNS.map((c) => "-".repeat(c.width)).join("  ");
  const rows = list.map((s) => COLUMNS.map((c) => padTo(c.get(s), c.width)).join("  "));
  return [header, sep, ...rows].join("\n");
}

export function renderJson(list) {
  return JSON.stringify(
    list.map((s) => ({
      id: s.id,
      name: s.name,
      displayName: s.displayName,
      cwd: s.cwd,
      created: s.created,
      lastActivity: s.lastActivity,
      lastMessage: s.lastMessage,
      mtime: s.mtime,
      size: s.size,
      messageCount: s.messageCount,
      turnCount: s.turnCount,
      model: s.model,
      provider: s.provider,
      archived: s.archived,
      path: s.path,
      preview: s.preview,
    })),
    null,
    2,
  );
}

export function renderCsv(list) {
  const cols = [
    "id",
    "name",
    "cwd",
    "created",
    "lastActivity",
    "lastMessage",
    "mtime",
    "size",
    "turnCount",
    "model",
    "archived",
    "path",
  ];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const s of list) {
    const row = cols.map((c) => {
      if (["created", "lastActivity", "lastMessage", "mtime"].includes(c)) return formatLocal(s[c]);
      return s[c];
    });
    lines.push(row.map(esc).join(","));
  }
  return lines.join("\n");
}
