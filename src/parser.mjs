// Pi session parser. Streaming, tolerant of malformed/partial lines.
//
// Entry types: session, session_info, model_change, usage, compaction,
// custom_message, message. Message roles: system, user, assistant,
// toolResult, bashExecution. Assistant content blocks: text, thinking,
// toolCall.
//
// Time fields produced (epoch ms, UTC):
//   created      = header timestamp
//   lastActivity = max timestamp over ANY entry
//   lastMessage  = max timestamp over message entries
//   mtime        = filesystem mtime
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { parseEntryTime } from "./time.mjs";
import { isArchived } from "./scanner.mjs";

export function idFromFilename(name) {
  const base = String(name).replace(/\.jsonl$/i, "");
  const i = base.lastIndexOf("_");
  return i >= 0 && i + 1 < base.length ? base.slice(i + 1) : base;
}

function blocksOf(content) {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content.filter((b) => b && typeof b === "object");
  return [];
}

function textOf(content) {
  const parts = [];
  for (const b of blocksOf(content)) {
    if (b.type === "text" && typeof b.text === "string" && b.text) parts.push(b.text);
  }
  return parts.join("\n");
}

async function* readEntries(file) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const s = line.trim();
      if (!s) continue;
      let entry = null;
      try {
        entry = JSON.parse(s);
      } catch {
        entry = null;
      }
      yield entry;
    }
  } finally {
    rl.close();
    stream.close();
  }
}

function baseMeta(file, stat) {
  return {
    path: file,
    id: idFromFilename(path.basename(file)),
    cwd: "",
    name: "",
    preview: "",
    created: null,
    firstActivity: null,
    lastActivity: null,
    lastMessage: null,
    activityTimes: [],
    mtime: stat.mtimeMs,
    size: stat.size,
    messageCount: 0,
    turnCount: 0,
    model: "",
    provider: "",
    archived: isArchived(file),
    parseErrors: 0,
    ok: true,
  };
}

function usageTokens(u) {
  if (!u || typeof u !== "object") return 0;
  const i = Number(u.input) || 0;
  const o = Number(u.output) || 0;
  if (i || o) return i + o;
  const t = Number(u.totalTokens) || 0;
  return t;
}

/** Light metadata scan for listing. */
export async function scanMeta(file) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return null;
  }
  const meta = baseMeta(file, stat);
  const activityTimes = [];
  let headerSeen = false;
  let turnOpen = false;
  let turnHasContent = false;
  const flushTurn = () => {
    if (turnOpen && turnHasContent) meta.turnCount++;
    turnOpen = false;
  };
  const openTurn = () => {
    flushTurn();
    turnOpen = true;
    turnHasContent = false;
  };
  const startTurn = () => {
    if (!turnOpen) openTurn();
  };
  const markContent = () => {
    turnHasContent = true;
  };

  try {
    for await (const entry of readEntries(file)) {
      if (!entry) {
        meta.parseErrors++;
        continue;
      }
      const ts = parseEntryTime(entry.timestamp);
      if (ts != null) {
        if (meta.lastActivity == null || ts > meta.lastActivity) meta.lastActivity = ts;
        if (meta.firstActivity == null || ts < meta.firstActivity) meta.firstActivity = ts;
        activityTimes.push(ts);
      }
      switch (entry.type) {
        case "session": {
          headerSeen = true;
          if (entry.id) meta.id = entry.id;
          if (entry.cwd) meta.cwd = entry.cwd;
          const c = parseEntryTime(entry.timestamp);
          if (c != null) meta.created = c;
          break;
        }
        case "session_info":
          if (typeof entry.name === "string" && entry.name.trim()) meta.name = entry.name.trim();
          break;
        case "model_change":
          if (entry.modelId) meta.model = entry.modelId;
          if (entry.provider) meta.provider = entry.provider;
          break;
        case "message": {
          const msg = entry.message;
          if (!msg || typeof msg !== "object") break;
          meta.messageCount++;
          if (typeof msg.model === "string" && msg.model) meta.model = msg.model;
          if (typeof msg.provider === "string" && msg.provider) meta.provider = msg.provider;
          const role = msg.role;
          if (role === "system") break;
          if (ts != null && (meta.lastMessage == null || ts > meta.lastMessage)) meta.lastMessage = ts;
          if (role === "user") {
            openTurn();
            const text = textOf(msg.content).trim();
            if (text) {
              markContent();
              if (!meta.preview) meta.preview = text;
            }
          } else if (role === "assistant") {
            startTurn();
            for (const b of blocksOf(msg.content)) {
              if (b.type === "text" && typeof b.text === "string" && b.text.trim()) markContent();
              else if (b.type === "toolCall") markContent();
            }
          } else if (role === "toolResult") {
            startTurn();
          } else if (role === "bashExecution") {
            startTurn();
            markContent();
          }
          break;
        }
      }
    }
  } catch {
    meta.ok = false;
  }
  flushTurn();
  meta.activityTimes = [...new Set(activityTimes)].sort((a, b) => a - b);
  if (!headerSeen && !meta.cwd) {
    /* id already derived from filename */
  }
  meta.displayName = meta.name || firstLine(meta.preview, 80) || meta.id;
  return meta;
}

function firstLine(s, max) {
  if (!s) return "";
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "\u2026" : one;
}

/** Full parse: metadata + reconstructed turns (for export / preview). */
export async function parseFull(file) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return null;
  }
  const meta = baseMeta(file, stat);
  const turns = [];
  let turnIndex = -1;
  const ensureTurn = (ts) => {
    if (turnIndex < 0) {
      turnIndex = 0;
      turns.push(newTurn(0, ts));
    }
    return turnIndex;
  };
  const cur = () => (turnIndex >= 0 && turnIndex < turns.length ? turns[turnIndex] : null);

  try {
    for await (const entry of readEntries(file)) {
      if (!entry) {
        meta.parseErrors++;
        continue;
      }
      const ts = parseEntryTime(entry.timestamp);
      if (ts != null && (meta.lastActivity == null || ts > meta.lastActivity)) meta.lastActivity = ts;
      switch (entry.type) {
        case "session":
          if (entry.id) meta.id = entry.id;
          if (entry.cwd) meta.cwd = entry.cwd;
          meta.created = parseEntryTime(entry.timestamp) ?? meta.created;
          break;
        case "session_info":
          if (typeof entry.name === "string" && entry.name.trim()) meta.name = entry.name.trim();
          break;
        case "model_change":
          if (entry.modelId) meta.model = entry.modelId;
          if (entry.provider) meta.provider = entry.provider;
          break;
        case "compaction": {
          const idx = ensureTurn(ts);
          if (entry.summary && String(entry.summary).trim()) {
            turns[idx].notices.push({ kind: "compaction", text: String(entry.summary).trim() });
          }
          break;
        }
        case "custom_message": {
          if (entry.display === false) break;
          const idx = ensureTurn(ts);
          const text = textOf(entry.content).trim();
          if (text) turns[idx].notices.push({ kind: "custom", text });
          break;
        }
        case "message": {
          const msg = entry.message;
          if (!msg || typeof msg !== "object") break;
          meta.messageCount++;
          if (typeof msg.model === "string" && msg.model) meta.model = msg.model;
          if (typeof msg.provider === "string" && msg.provider) meta.provider = msg.provider;
          const role = msg.role;
          if (role === "system") break;
          if (ts != null && (meta.lastMessage == null || ts > meta.lastMessage)) meta.lastMessage = ts;

          if (role === "user") {
            turnIndex++;
            turns.push(newTurn(turnIndex, ts));
            const text = textOf(msg.content).trim();
            if (text) {
              turns[turnIndex].user = text;
              if (!meta.preview) meta.preview = text;
            }
          } else if (role === "assistant") {
            const idx = ensureTurn(ts);
            const turn = turns[idx];
            if (Number(msg.durationMs) > 0) turn.durationMs += Number(msg.durationMs);
            if (msg.usage) {
              turn.tokens += usageTokens(msg.usage);
              turn.requests++;
            }
            for (const b of blocksOf(msg.content)) {
              if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
                turn.assistant = turn.assistant ? turn.assistant + "\n" + b.text : b.text;
              } else if (b.type === "toolCall") {
                turn.tools.push(b.name || "tool");
                turn.toolCalls.push({ name: b.name || "tool", args: b.arguments ?? null });
              }
            }
            if (msg.errorMessage) turn.errors++;
          } else if (role === "toolResult") {
            const idx = ensureTurn(ts);
            const turn = turns[idx];
            if (Number(msg.durationMs) > 0) turn.durationMs += Number(msg.durationMs);
            if (msg.isError) turn.errors++;
            turn.toolResults.push({ name: msg.toolName || "tool", isError: !!msg.isError });
          } else if (role === "bashExecution") {
            const idx = ensureTurn(ts);
            const turn = turns[idx];
            turn.tools.push("bash");
            turn.toolCalls.push({ name: "bash", args: { command: msg.command || "" } });
            if (msg.cancelled || (msg.exitCode != null && msg.exitCode !== 0)) turn.errors++;
          }
          break;
        }
      }
    }
  } catch {
    meta.ok = false;
  }

  const filtered = turns.filter((t) => t.user || t.assistant || t.tools.length || t.notices.length);
  meta.turnCount = filtered.length;
  meta.displayName = meta.name || firstLine(meta.preview, 80) || meta.id;
  return { meta, turns: filtered };
}

function newTurn(index, ts) {
  return {
    index,
    startedAt: ts ?? null,
    user: "",
    assistant: "",
    tools: [],
    toolCalls: [],
    toolResults: [],
    notices: [],
    tokens: 0,
    durationMs: 0,
    requests: 0,
    errors: 0,
  };
}
