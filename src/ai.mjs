// AI features: summarize one session, summarize a filtered batch, and ask
// questions across a filtered batch. The provider/endpoint shapes are
// magpie's (OpenAI chat, OpenAI Responses, Anthropic messages, Gemini), so a
// provider added in the same shape works here.
import { parseFull } from "./parser.mjs";
import { formatLocal } from "./time.mjs";
import { callTargets, getProvider } from "./providers.mjs";

// ---------------------------------------------------------------- client

function joinUrl(base, suffix) {
  return String(base).replace(/\/+$/, "") + suffix;
}

function headersFor(p, kind) {
  const h = { "Content-Type": "application/json" };
  Object.assign(h, p.headers && typeof p.headers === "object" ? p.headers : {});
  if (p.key) {
    if (kind === "anthropic") {
      h["x-api-key"] = p.key;
      h["anthropic-version"] = h["anthropic-version"] || "2023-06-01";
    } else if (kind === "gemini") {
      h["x-goog-api-key"] = p.key;
    } else {
      h["Authorization"] = `Bearer ${p.key}`;
    }
  }
  return h;
}

/** Split a text/event-stream body into `data:` payload strings. */
async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith("data:")) yield buf.slice(5).trim();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function buildRequest(target, p, opts) {
  const { model, messages, system, temperature, maxTokens, stream } = opts;
  const max = maxTokens || 4096;
  if (target.kind === "chat") {
    const msgs = system ? [{ role: "system", content: system }, ...messages] : messages;
    return {
      url: target.url,
      kind: target.kind,
      body: { model, messages: msgs, stream, temperature, max_tokens: max },
    };
  }
  if (target.kind === "responses") {
    const input = messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: m.role === "assistant" ? "output_text" : "input_text", text: m.content }],
    }));
    return {
      url: target.url,
      kind: target.kind,
      body: {
        model,
        input,
        instructions: system || undefined,
        stream,
        temperature,
        max_output_tokens: max,
      },
    };
  }
  if (target.kind === "anthropic") {
    return {
      url: target.url,
      kind: target.kind,
      body: { model, system: system || undefined, messages, max_tokens: max, stream, temperature },
    };
  }
  // gemini
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  return {
    url: joinUrl(target.url, `/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent" : "generateContent"}`),
    kind: target.kind,
    body: {
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: { temperature, maxOutputTokens: max },
    },
    query: stream ? "alt=sse" : "",
  };
}

function deltaOf(kind, json) {
  try {
    if (kind === "chat") return json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || "";
    if (kind === "anthropic") {
      if (json.type === "content_block_delta") return json.delta?.text || "";
      return "";
    }
    if (kind === "gemini") {
      const parts = json.candidates?.[0]?.content?.parts || [];
      return parts.map((x) => x.text || "").join("");
    }
    if (kind === "responses") return json.delta || "";
  } catch {
    /* ignore */
  }
  return "";
}

function errorFrom(kind, json, status) {
  const e = json?.error;
  const msg = (e && (e.message || e.type)) || json?.message || (typeof e === "string" ? e : null);
  return new Error(`HTTP ${status}${msg ? " · " + String(msg).slice(0, 300) : ""}`);
}

/** Call one endpoint, yielding text deltas. */
async function* streamTarget(target, p, opts) {
  const { url, kind, body, query } = buildRequest(target, p, opts);
  const full = query ? url + (url.includes("?") ? "&" : "?") + query : url;
  const res = await fetch(full, {
    method: "POST",
    headers: headersFor(p, kind),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let json = null;
    try {
      json = JSON.parse(await res.text());
    } catch {
      /* ignore */
    }
    throw errorFrom(kind, json, res.status);
  }
  if (!opts.stream) {
    const json = await res.json().catch(() => null);
    if (kind === "gemini") {
      const parts = json?.candidates?.[0]?.content?.parts || [];
      yield parts.map((x) => x.text || "").join("");
    } else {
      yield deltaOf(kind, json);
    }
    return;
  }
  for await (const data of sseData(res)) {
    if (!data || data === "[DONE]") continue;
    let json = null;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const d = deltaOf(kind, json);
    if (d) yield d;
  }
}

/**
 * Stream a chat completion from a provider, trying each endpoint it speaks
 * until one answers. `messages` are `{role,content}` in OpenAI's shape.
 */
export async function* chatStream(provider, opts) {
  const p = typeof provider === "string" ? getProvider(provider) : provider;
  if (!p) throw new Error("未找到供应商");
  const targets = callTargets(p);
  if (!targets.length) throw new Error(`供应商「${p.name || p.id}」没有可用的接口地址`);
  let lastErr = null;
  for (const target of targets) {
    try {
      let got = false;
      for await (const d of streamTarget(target, p, opts)) {
        got = true;
        yield d;
      }
      if (got) return;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("供应商没有任何返回");
}

/** Non-streaming completion; returns the whole text. */
export async function complete(provider, opts) {
  let out = "";
  for await (const d of chatStream(provider, { ...opts, stream: false })) out += d;
  return out;
}

// ---------------------------------------------------------------- transcripts

const DEFAULT_TRANSCRIPT_CHARS = 160_000;

/**
 * How many transcript characters to feed the model, from its own context
 * window when the provider's model metadata says so (~3 chars/token, 60% of
 * the window), else a safe default.
 */
export function contextBudget(provider, model, fallback = DEFAULT_TRANSCRIPT_CHARS) {
  const m = provider && provider.modelMeta && provider.modelMeta[model];
  const ctx = m && Number(m.context);
  if (!ctx || !Number.isFinite(ctx)) return fallback;
  return Math.max(20_000, Math.min(600_000, Math.floor(ctx * 3 * 0.6)));
}

/**
 * Render a session's turns as a plain transcript for the model, trimming to
 * a character budget (head and tail are kept, the middle is elided).
 */
export function renderTranscript(meta, turns, { maxChars = DEFAULT_TRANSCRIPT_CHARS, perTurn = 6000 } = {}) {
  const head = [
    `会话名称：${meta.displayName || meta.name || meta.id}`,
    `工作目录：${meta.cwd || "-"}`,
    `模型：${meta.model || "-"}`,
    `创建时间：${formatLocal(meta.created)}`,
    `最后活动：${formatLocal(meta.lastActivity)}`,
    `轮次：${turns.length}`,
  ].join("\n");

  const turnTexts = turns.map((t) => {
    const lines = [`## 第 ${t.index + 1} 轮`];
    if (t.user) lines.push(`用户：${clip(t.user, perTurn)}`);
    if (t.assistant) lines.push(`助手：${clip(t.assistant, perTurn)}`);
    if (t.tools.length) lines.push(`工具：${[...new Set(t.tools)].join(", ")}`);
    return lines.join("\n");
  });

  const budget = Math.max(4000, maxChars - head.length);
  const kept = [];
  let used = 0;
  // keep the opening turns (the task) and the closing turns (the outcome)
  const headCount = Math.ceil(turnTexts.length * 0.6);
  for (let i = 0; i < turnTexts.length; i++) {
    const isTail = i >= headCount;
    if (used + turnTexts[i].length > budget && kept.length && !isTail) {
      kept.push("…（中间轮次已省略）…");
      used += 12;
      continue;
    }
    if (used + turnTexts[i].length > budget) break;
    kept.push(turnTexts[i]);
    used += turnTexts[i].length;
  }
  return `${head}\n\n${kept.join("\n\n")}`;
}

function clip(s, n) {
  const str = String(s || "");
  if (str.length <= n) return str;
  return str.slice(0, n) + `\n…（此处省略 ${str.length - n} 字）…`;
}

export async function loadTranscript(meta, opts) {
  const parsed = await parseFull(meta.path);
  if (!parsed) throw new Error(`无法读取会话：${meta.path}`);
  return { parsed, text: renderTranscript(parsed.meta, parsed.turns, opts) };
}

// ---------------------------------------------------------------- prompts

const LANG_NOTE = {
  zh: "请用简体中文回答。",
  en: "Answer in English.",
};

function langNote(lang) {
  return LANG_NOTE[lang] || LANG_NOTE.zh;
}

const SINGLE_SYSTEM = `你是一名资深的软件工程助手，擅长把 AI 编码 agent 的会话记录整理成清晰、准确、可执行的总结。
要求：
- 只依据给定记录，不要编造记录里没有的信息；不确定就写“记录中未提及”。
- 保留关键的路径、文件名、命令、错误信息与结论。
- 结构清晰，使用 Markdown 小标题与要点。`;

function singlePrompt(meta, transcript) {
  return `下面是一条 AI 编码 agent 会话的完整记录。请总结这条会话。

输出格式（Markdown）：
## 一句话概括
## 背景与目标
## 主要工作
（按时间或主题列出做了什么，包含关键文件/命令）
## 关键决策与原因
## 遇到的问题与解决
## 最终结果 / 产出
## 未完成与后续建议

会话记录：
"""
${transcript}
"""`;
}

const BATCH_SESSION_SYSTEM = `你是一名软件工程助手。你会看到一条 AI 编码会话的片段，请提炼要点，供后续汇总使用。
只依据记录内容，不要编造。使用 Markdown 要点，尽量简短。`;

function batchSessionPrompt(meta, transcript) {
  return `会话名称：${meta.displayName || meta.id}
工作目录：${meta.cwd || "-"}
时间：${formatLocal(meta.created)} ~ ${formatLocal(meta.lastActivity)}

请用 3-6 条要点提炼这条会话（做了什么、涉及哪些文件/命令、结论或遗留问题）：

"""
${transcript}
"""`;
}

const BATCH_FINAL_SYSTEM = `你是一名软件工程负责人，擅长把多条 AI 编码会话的要点汇总成一份可读的工作总结。
只依据给定的要点，不要编造。使用 Markdown。`;

function batchFinalPrompt(items, range) {
  const body = items
    .map(
      (it, i) =>
        `### ${i + 1}. ${it.name}\n- 工作目录：${it.cwd || "-"}\n- 时间：${formatLocal(it.created)}\n${it.summary}`,
    )
    .join("\n\n");
  return `下面是 ${items.length} 条 AI 编码会话的要点${range ? `（时间范围：${range}）` : ""}。请汇总成一份工作总结。

输出格式（Markdown）：
## 总览
## 按项目 / 工作目录
## 主要成果
## 反复出现的问题或风险
## 建议的后续动作

会话要点：
${body}`;
}

const QA_SYSTEM = `你是一名软件工程助手。用户会就一批 AI 编码会话记录提问。
要求：
- 只依据给定记录回答，不要编造；记录里没有就明确说明。
- 引用时指出是哪个会话（会话名称或工作目录）。
- 使用 Markdown，先给结论，再给依据。`;

// ---------------------------------------------------------------- features

/**
 * Summarize one session, streaming the summary text.
 * @returns {AsyncGenerator<string>}
 */
export async function* summarizeSession(provider, model, meta, { lang = "zh", maxChars } = {}) {
  const { text } = await loadTranscript(meta, { maxChars: maxChars || contextBudget(provider, model) });
  const system = `${SINGLE_SYSTEM}\n${langNote(lang)}`;
  yield* chatStream(provider, {
    model,
    system,
    messages: [{ role: "user", content: singlePrompt(meta, text) }],
    stream: true,
    maxTokens: 3000,
  });
}

/**
 * Summarize a batch of sessions in two stages. Yields progress events:
 *   {type:'progress', phase, index, total, name}
 *   {type:'session', id, name, summary}
 *   {type:'final', text}
 *   {type:'error', message, id?}
 */
export async function* summarizeBatch(provider, model, sessions, { lang = "zh", range, maxChars, concurrency = 3 } = {}) {
  const total = sessions.length;
  const items = [];
  let done = 0;
  const perSessionChars =
    maxChars || Math.max(8_000, Math.min(40_000, Math.floor(contextBudget(provider, model) * 0.25)));

  async function one(meta) {
    const { text } = await loadTranscript(meta, { maxChars: perSessionChars });
    let summary = "";
    for await (const d of chatStream(provider, {
      model,
      system: `${BATCH_SESSION_SYSTEM}\n${langNote(lang)}`,
      messages: [{ role: "user", content: batchSessionPrompt(meta, text) }],
      stream: false,
      maxTokens: 800,
    })) {
      summary += d;
    }
    return summary.trim();
  }

  // simple concurrency pool
  const queue = sessions.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const meta = queue.shift();
      if (!meta) return;
      try {
        const summary = await one(meta);
        items.push({ id: meta.id, name: meta.displayName || meta.name || meta.id, cwd: meta.cwd, created: meta.created, summary });
        done++;
        yieldQueue.push({ type: "session", id: meta.id, name: meta.displayName || meta.id, summary, done, total });
      } catch (e) {
        done++;
        yieldQueue.push({ type: "error", id: meta.id, message: String(e && e.message ? e.message : e) });
      }
      yieldQueue.push({ type: "progress", phase: "sessions", index: done, total });
    }
  });

  // The worker pool can't yield directly, so events land in a queue the
  // generator drains while the pool runs.
  const yieldQueue = [];
  let finished = false;
  const pool = Promise.all(workers).finally(() => {
    finished = true;
  });

  for (;;) {
    while (yieldQueue.length) yield yieldQueue.shift();
    if (finished && !yieldQueue.length) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  await pool;

  items.sort((a, b) => (a.created || 0) - (b.created || 0));
  yield { type: "progress", phase: "final", index: total, total };
  let final = "";
  try {
    for await (const d of chatStream(provider, {
      model,
      system: `${BATCH_FINAL_SYSTEM}\n${langNote(lang)}`,
      messages: [{ role: "user", content: batchFinalPrompt(items, range) }],
      stream: true,
      maxTokens: 4000,
    })) {
      final += d;
      yield { type: "delta", text: d };
    }
    yield { type: "final", text: final };
  } catch (e) {
    yield { type: "error", message: String(e && e.message ? e.message : e) };
  }
}

function keywords(q) {
  const words = String(q || "")
    .toLowerCase()
    .split(/[\s,，。、;；:：!！?？"'“”()（）\[\]{}<>/\\|]+/)
    .filter((w) => w.length >= 2);
  return [...new Set(words)];
}

/**
 * Answer a question across a batch of sessions: pick the most relevant ones
 * by keyword, then stream a grounded answer.
 * @returns {AsyncGenerator<{type,text?}>}
 */
export async function* askSessions(provider, model, sessions, question, { history = [], lang = "zh", budget, topK = 8 } = {}) {
  const cap = budget || contextBudget(provider, model);
  const words = keywords(question);
  // cheap metadata score first
  const scored = sessions.map((s) => {
    const hay = `${s.displayName || ""} ${s.name || ""} ${s.preview || ""} ${s.cwd || ""}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += 3;
    return { meta: s, score };
  });
  scored.sort((a, b) => b.score - a.score || (b.meta.lastActivity || 0) - (a.meta.lastActivity || 0));
  const shortlist = scored.slice(0, Math.max(topK, 12));

  // deep score with transcripts, filling a character cap
  const picked = [];
  let used = 0;
  for (const { meta } of shortlist) {
    if (picked.length >= topK || used >= cap) break;
    let text;
    try {
      text = (await loadTranscript(meta, { maxChars: Math.min(30_000, cap) })).text;
    } catch {
      continue;
    }
    const low = text.toLowerCase();
    let score = 0;
    for (const w of words) score += low.split(w).length - 1;
    if (score === 0 && picked.length >= 3) continue;
    const room = cap - used;
    const slice = text.length > room ? text.slice(0, room) : text;
    picked.push({ meta, text: slice, score });
    used += slice.length;
  }
  if (!picked.length) {
    // nothing matched: fall back to the most recent few
    for (const { meta } of scored.slice(0, 3)) {
      try {
        const text = (await loadTranscript(meta, { maxChars: Math.floor(cap / 3) })).text;
        picked.push({ meta, text, score: 0 });
      } catch {
        /* ignore */
      }
    }
  }

  const context = picked
    .map(
      (p, i) =>
        `### 会话 ${i + 1}：${p.meta.displayName || p.meta.id}\n- 工作目录：${p.meta.cwd || "-"}\n- 时间：${formatLocal(p.meta.created)} ~ ${formatLocal(p.meta.lastActivity)}\n\n${p.text}`,
    )
    .join("\n\n---\n\n");

  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    {
      role: "user",
      content: `以下是与问题相关的会话记录：\n\n${context}\n\n---\n\n问题：${question}`,
    },
  ];

  yield { type: "sources", sources: picked.map((p) => ({ id: p.meta.id, name: p.meta.displayName || p.meta.id, cwd: p.meta.cwd })) };
  for await (const d of chatStream(provider, {
    model,
    system: `${QA_SYSTEM}\n${langNote(lang)}`,
    messages,
    stream: true,
    maxTokens: 3000,
  })) {
    yield { type: "delta", text: d };
  }
}
