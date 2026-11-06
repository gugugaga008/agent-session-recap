"use strict";

/* =======================================================================
 * AI 与供应商 —— 供应商模块的设计、数据形状与「添加供应商」交互参照 magpie
 * 项目（https://github.com/yetone/magpie）。
 * ===================================================================== */

const CONFIG_HINT = "~/.config/agent-session-recap/providers.json";

let providers = [];
let presets = [];
let apiKinds = [];
let presetGroups = [];
let prefs = {};
let formState = null;

async function apiJson(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || "HTTP " + res.status);
  return data;
}

// ---- 图标 ----
function iconColor(icon) {
  const s = String(icon || "generic");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 45%)`;
}
function iconBadge(icon, iconUrl, name) {
  if (iconUrl) return `<span class="ico"><img src="${esc(iconUrl)}" alt=""></span>`;
  const label =
    String(name || icon || "?").replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, "").slice(0, 2).toUpperCase() || "?";
  return `<span class="ico" style="background:${iconColor(icon)}">${esc(label)}</span>`;
}

// ---- 极简 Markdown 渲染 ----
function mdToHtml(src) {
  const lines = String(src || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let code = [];
  let inList = false;
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
        code = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const t = line.trim();
    if (!t) {
      closeList();
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(t))) {
      closeList();
      const lvl = Math.min(6, m[1].length);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if (/^(---|\*\*\*|___)$/.test(t)) {
      closeList();
      out.push("<hr>");
      continue;
    }
    if ((m = /^[-*+]\s+(.*)$/.exec(t)) || (m = /^\d+[.)]\s+(.*)$/.exec(t))) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push("<li>" + inline(m[1]) + "</li>");
      continue;
    }
    closeList();
    out.push("<p>" + inline(t) + "</p>");
  }
  if (inCode) out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
  closeList();
  return out.join("\n");
}

// ---- 供应商数据 ----
async function loadProviders() {
  const data = await apiJson("/api/providers");
  providers = data.providers || [];
  presets = data.presets || [];
  apiKinds = data.apiKinds || apiKinds;
  presetGroups = data.groups || presetGroups;
  prefs = data.prefs || {};
  renderAiModelOptions();
  return data;
}

function activeProviders() {
  return providers.filter((p) => !p.off);
}

function hostOf(p) {
  const url = p.chat || p.responses || p.anthropic || p.gemini || p.decide || "";
  try {
    return url ? new URL(url).host : "自定义";
  } catch {
    return url || "自定义";
  }
}

function tagOf(p) {
  const pr = presets.find((x) => x.id === p.preset);
  if (pr && pr.kind === "partner") return '<span class="tag partner">合作伙伴</span>';
  if (pr && pr.kind === "local") return '<span class="tag local">本机</span>';
  if (p.preset) return '<span class="tag preset">预设</span>';
  return '<span class="tag">自定义</span>';
}

// ---- AI 面板 ----
const ai = { mode: null, ctrl: null, raw: "", progress: "", history: [], selected: [], messages: [] };

function setAiStatus(msg, kind) {
  const el = $("aiStatus");
  el.textContent = msg || "";
  el.className = "muted" + (kind ? " " + kind : "");
}
function renderAiOutput() {
  const el = $("aiOutput");
  el.innerHTML = ai.raw ? mdToHtml(ai.raw) : '<div class="placeholder">等待输出…</div>';
  el.scrollTop = el.scrollHeight;
}
function renderAiMessages() {
  const el = $("aiOutput");
  el.innerHTML = ai.messages
    .map((m) => {
      const src = m.sources ? `<div class="src">参考会话：${esc(m.sources)}</div>` : "";
      return `<div class="msg ${m.role}"><span class="who">${m.role === "user" ? "你" : "AI"}</span>${src}${
        m.role === "user" ? esc(m.content) : mdToHtml(m.content)
      }</div>`;
    })
    .join("");
  el.scrollTop = el.scrollHeight;
}
function renderAiProgress() {
  $("aiProgress").innerHTML = ai.progress || "";
}

function openAiPanel(mode, title, meta) {
  ai.mode = mode;
  ai.raw = "";
  ai.messages = [];
  ai.progress = "";
  $("aiTitle").textContent = title;
  $("aiMeta").textContent = meta || "";
  $("aiModal").classList.remove("hidden");
  $("aiAskRow").classList.toggle("hidden", mode !== "chat");
  $("aiStop").classList.add("hidden");
  renderAiProgress();
  if (mode === "chat") renderAiMessages();
  else renderAiOutput();
}
function closeAiPanel() {
  if (ai.ctrl) ai.ctrl.abort();
  ai.ctrl = null;
  $("aiModal").classList.add("hidden");
}

async function streamPost(url, body, onEvent, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = "HTTP " + res.status;
    try {
      const j = await res.json();
      msg = j.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (!d) continue;
        let ev;
        try {
          ev = JSON.parse(d);
        } catch {
          continue;
        }
        onEvent(ev);
      }
    }
  }
}

function aiRequestBase() {
  const p = providers.find((x) => x.id === $("aiProvider").value) || activeProviders()[0];
  if (!p) throw new Error("没有可用的供应商");
  const model = $("aiModel").value || p.models[0] || p.pickedFrom[0] || "";
  return { providerId: p.id, model };
}

async function ensureAiReady() {
  try {
    await loadProviders();
  } catch {
    /* ignore */
  }
  if (!activeProviders().length) {
    alert("还没有可用的 AI 供应商。请先在「AI 供应商」里添加一个。");
    openProviders();
    return false;
  }
  return true;
}

function requireModel(base) {
  if (base.model) return true;
  alert("请先为该供应商选择或填写模型。");
  openProviders();
  return false;
}

// ---- 1) 单条会话总结 ----
async function aiSummarizeSingle(meta) {
  if (!(await ensureAiReady())) return;
  let base;
  try {
    base = aiRequestBase();
  } catch (e) {
    alert(e.message);
    return;
  }
  if (!requireModel(base)) return;
  ai.selected = [meta];
  openAiPanel("single", "AI 总结", meta.displayName || meta.id);
  ai.progress = `正在读取会话并生成总结…`;
  renderAiProgress();
  ai.ctrl = new AbortController();
  $("aiStop").classList.remove("hidden");
  setAiStatus("生成中…");
  try {
    await streamPost(
      "/api/ai/summarize",
      { ...base, ids: [meta.id], lang: "zh" },
      (ev) => {
        if (ev.type === "delta") {
          ai.raw += ev.text;
          renderAiOutput();
        } else if (ev.type === "error") {
          ai.raw += `\n\n> ⚠️ ${ev.message}\n`;
          renderAiOutput();
        } else if (ev.type === "done") {
          setAiStatus("完成");
        }
      },
      ai.ctrl.signal,
    );
  } catch (e) {
    if (e.name !== "AbortError") {
      ai.raw += `\n\n> ⚠️ 失败：${e.message}\n`;
      renderAiOutput();
      setAiStatus("失败", "err");
    } else setAiStatus("已停止");
  } finally {
    $("aiStop").classList.add("hidden");
    ai.ctrl = null;
  }
}

// ---- 2) 批量摘要 ----
async function aiBatchSummarize() {
  if (!(await ensureAiReady())) return;
  const ids = selectedIds().length ? selectedIds() : sessions.map((s) => s.id);
  if (!ids.length) {
    alert("没有可总结的会话，请先筛选。");
    return;
  }
  let base;
  try {
    base = aiRequestBase();
  } catch (e) {
    alert(e.message);
    return;
  }
  if (!requireModel(base)) return;
  const chosen = sessions.filter((s) => ids.includes(s.id));
  const created = chosen.map((s) => s.created).filter((x) => x);
  const ended = chosen.map((s) => s.lastActivity).filter((x) => x);
  const range = created.length
    ? `${fmtTime(Math.min(...created))} ~ ${fmtTime(Math.max(...ended))}`
    : "";
  openAiPanel("batch", "AI 摘要总结", `${ids.length} 个会话`);
  ai.progress = `准备逐条摘要 ${ids.length} 个会话…`;
  renderAiProgress();
  ai.ctrl = new AbortController();
  $("aiStop").classList.remove("hidden");
  setAiStatus("逐条摘要中…");
  const perSession = [];
  try {
    await streamPost(
      "/api/ai/summarize-batch",
      { ...base, ids, lang: "zh", range },
      (ev) => {
        if (ev.type === "progress") {
          ai.progress =
            ev.phase === "final"
              ? `已完成 ${ev.total} 条，正在汇总…`
              : `逐条摘要 ${ev.index}/${ev.total}…<ul class="ai-progress-list">${perSession.join("")}</ul>`;
          renderAiProgress();
        } else if (ev.type === "session") {
          perSession.push(`<li>${esc(ev.name)}</li>`);
          ai.progress = `逐条摘要 ${ev.done}/${ev.total}…<ul class="ai-progress-list">${perSession.join("")}</ul>`;
          renderAiProgress();
        } else if (ev.type === "delta") {
          ai.raw += ev.text;
          renderAiOutput();
        } else if (ev.type === "final") {
          ai.raw = ev.text;
          renderAiOutput();
          setAiStatus("完成");
        } else if (ev.type === "error" && !ev.id) {
          ai.raw += `\n\n> ⚠️ ${ev.message}\n`;
          renderAiOutput();
        } else if (ev.type === "done") {
          setAiStatus("完成");
        }
      },
      ai.ctrl.signal,
    );
  } catch (e) {
    if (e.name !== "AbortError") {
      ai.raw += `\n\n> ⚠️ 失败：${e.message}\n`;
      renderAiOutput();
      setAiStatus("失败", "err");
    } else setAiStatus("已停止");
  } finally {
    $("aiStop").classList.add("hidden");
    ai.ctrl = null;
  }
}

// ---- 3) AI 提问 ----
async function aiAskSessions() {
  if (!(await ensureAiReady())) return;
  if (!sessions.length) {
    alert("没有可用于提问的会话，请先筛选。");
    return;
  }
  let base;
  try {
    base = aiRequestBase();
  } catch (e) {
    alert(e.message);
    return;
  }
  if (!requireModel(base)) return;
  ai.selected = sessions;
  ai.history = [];
  ai.messages = [];
  openAiPanel("chat", "AI 提问", `${sessions.length} 个筛选出的会话`);
  ai.messages.push({
    role: "assistant",
    content: `已加载 **${sessions.length}** 个会话作为上下文。直接提问即可，例如：\n\n- 这些会话里主要改动了哪些文件？\n- 有哪些遗留问题？\n- 总结一下踩过的坑。`,
  });
  renderAiMessages();
  setAiStatus("");
  $("aiQuestion").focus();
}

async function aiSendQuestion() {
  const q = $("aiQuestion").value.trim();
  if (!q) return;
  if (!ai.selected.length) {
    alert("请先点「对筛选结果提问」。");
    return;
  }
  let base;
  try {
    base = aiRequestBase();
  } catch (e) {
    alert(e.message);
    return;
  }
  const prior = ai.history.slice();
  ai.history.push({ role: "user", content: q });
  ai.messages.push({ role: "user", content: q });
  const assistantIdx = ai.messages.push({ role: "assistant", content: "" }) - 1;
  renderAiMessages();
  $("aiQuestion").value = "";
  $("aiSend").disabled = true;
  ai.ctrl = new AbortController();
  $("aiStop").classList.remove("hidden");
  setAiStatus("思考中…");
  let text = "";
  try {
    await streamPost(
      "/api/ai/chat",
      { ...base, ids: ai.selected.map((s) => s.id), question: q, history: prior, lang: "zh" },
      (ev) => {
        if (ev.type === "sources") {
          ai.messages[assistantIdx].sources = (ev.sources || []).map((s) => s.name).join("、");
          renderAiMessages();
        } else if (ev.type === "delta") {
          text += ev.text;
          ai.messages[assistantIdx].content = text;
          renderAiMessages();
        } else if (ev.type === "error") {
          text += `\n\n> ⚠️ ${ev.message}`;
          ai.messages[assistantIdx].content = text;
          renderAiMessages();
        } else if (ev.type === "done") {
          setAiStatus("完成");
        }
      },
      ai.ctrl.signal,
    );
    ai.history.push({ role: "assistant", content: text });
  } catch (e) {
    if (e.name !== "AbortError") {
      ai.messages[assistantIdx].content = text + `\n\n> ⚠️ 失败：${e.message}`;
      renderAiMessages();
      setAiStatus("失败", "err");
    } else setAiStatus("已停止");
  } finally {
    $("aiSend").disabled = false;
    $("aiStop").classList.add("hidden");
    ai.ctrl = null;
  }
}

// ---- AI 供应商 / 模型选择器 ----
function renderAiModelOptions() {
  const active = activeProviders();
  const psel = $("aiProvider");
  const keep = psel.value;
  psel.innerHTML = "";
  if (!active.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "（未配置供应商）";
    psel.appendChild(o);
  } else {
    for (const p of active) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name || p.id;
      psel.appendChild(o);
    }
    if (keep && active.some((p) => p.id === keep)) psel.value = keep;
    else if (prefs.defaultProvider && active.some((p) => p.id === prefs.defaultProvider)) psel.value = prefs.defaultProvider;
  }
  renderAiModels();
  updateAiCurrent();
}
function renderAiModels() {
  const p = providers.find((x) => x.id === $("aiProvider").value);
  const msel = $("aiModel");
  msel.innerHTML = "";
  const models = p ? [...new Set([...(p.models || []), ...(p.pickedFrom || [])])] : [];
  if (!models.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = p ? "（该供应商暂无模型）" : "—";
    msel.appendChild(o);
    return;
  }
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    msel.appendChild(o);
  }
  if (prefs.defaultModel && models.includes(prefs.defaultModel)) msel.value = prefs.defaultModel;
}
function updateAiCurrent() {
  const p = providers.find((x) => x.id === $("aiProvider").value);
  const el = $("aiCurrent");
  if (!p) {
    el.textContent = "未配置 AI 供应商 · 点右上角「AI 供应商」添加";
    return;
  }
  const model = $("aiModel").value || p.models[0] || p.pickedFrom[0] || "未选模型";
  el.textContent = `${p.name || p.id} · ${model}`;
}

// ---- 供应商管理 ----
async function openProviders() {
  try {
    await loadProviders();
  } catch (e) {
    alert("读取供应商失败：" + e.message);
    return;
  }
  $("provModal").classList.remove("hidden");
  $("provStatus").textContent = CONFIG_HINT;
  renderProvList();
}
function closeProviders() {
  $("provModal").classList.add("hidden");
}
function renderProvList() {
  const box = $("provList");
  const q = $("provSearch").value.trim().toLowerCase();
  const list = providers.filter((p) => !q || (p.name || p.id).toLowerCase().includes(q));
  if (!list.length) {
    box.innerHTML = '<div class="prov-empty">还没有供应商。点右上角「＋ 添加供应商」。</div>';
    return;
  }
  box.innerHTML = "";
  for (const p of list) box.appendChild(provRow(p));
}
function provRow(p) {
  const row = document.createElement("div");
  row.className = "prov-row" + (p.off ? " off" : "");
  const count = (p.models && p.models.length) || (p.pickedFrom && p.pickedFrom.length) || 0;
  row.innerHTML = `
    ${iconBadge(p.icon, p.iconUrl, p.name)}
    <div class="grow">
      <div class="prov-name">${esc(p.name || p.id)} ${tagOf(p)}</div>
      <div class="prov-sub">${esc(hostOf(p))} · ${count} 个模型</div>
    </div>
    <span class="prov-key">${esc(p.keyMasked || (p.noKey ? "无需密钥" : "—"))}</span>
    <label class="switch"><input type="checkbox" ${p.off ? "" : "checked"}><span class="track"></span></label>
    <button class="icon-btn prov-edit" title="编辑">✎</button>
    <button class="icon-btn prov-del" title="删除">🗑</button>`;
  row.querySelector('input[type="checkbox"]').addEventListener("change", async (e) => {
    try {
      await apiJson("/api/providers/" + encodeURIComponent(p.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ off: !e.target.checked }),
      });
      await loadProviders();
      renderProvList();
    } catch (err) {
      alert("更新失败：" + err.message);
    }
  });
  row.querySelector(".prov-edit").addEventListener("click", () => openProviderForm({ provider: p }));
  row.querySelector(".prov-del").addEventListener("click", async () => {
    if (!confirm(`删除供应商「${p.name || p.id}」？`)) return;
    try {
      await apiJson("/api/providers/" + encodeURIComponent(p.id), { method: "DELETE" });
      await loadProviders();
      renderProvList();
    } catch (err) {
      alert("删除失败：" + err.message);
    }
  });
  return row;
}

// ---- 添加供应商（magpie 式：先选预设卡片，或自定义 URL） ----
function openAddProvider(provider) {
  if (provider) {
    openProviderForm({ provider });
    return;
  }
  formState = null;
  $("addProvPicker").classList.remove("hidden");
  $("addProvForm").classList.add("hidden");
  $("addProvBack").classList.add("hidden");
  $("addProvTitle").textContent = "添加供应商";
  $("addProvSave").textContent = "添加";
  $("addProvStatus").textContent = "";
  $("presetSearch").value = "";
  $("addProvModal").classList.remove("hidden");
  renderPicker();
  $("presetSearch").focus();
}
function closeAddProvider() {
  $("addProvModal").classList.add("hidden");
  formState = null;
}
function renderPicker() {
  const q = $("presetSearch").value.trim().toLowerCase();
  const box = $("presetGroups");
  box.innerHTML = "";
  for (const g of presetGroups) {
    const items = presets.filter((p) => p.kind === g.kind && (!q || (p.name || p.id).toLowerCase().includes(q)));
    if (!items.length) continue;
    const sec = document.createElement("div");
    sec.className = "preset-group";
    sec.innerHTML = `<h3>${esc(g.label)}<span class="note">${esc(g.note || "")}</span></h3>`;
    const grid = document.createElement("div");
    grid.className = "preset-grid";
    for (const p of items) grid.appendChild(presetCard(p));
    sec.appendChild(grid);
    box.appendChild(sec);
  }
  if (!q) {
    const sec = document.createElement("div");
    sec.className = "preset-group";
    sec.innerHTML = '<h3>自定义<span class="note">任意 OpenAI / Anthropic / Gemini 兼容的 URL</span></h3>';
    const grid = document.createElement("div");
    grid.className = "preset-grid";
    const btn = document.createElement("button");
    btn.className = "preset-card";
    btn.innerHTML =
      '<span class="ico" style="background:#64748b">＋</span><span class="pcol"><span class="pname">自定义供应商</span><span class="pnote">填名称与 Base URL</span></span>';
    btn.addEventListener("click", () => openProviderForm({ custom: true }));
    grid.appendChild(btn);
    sec.appendChild(grid);
    box.appendChild(sec);
  }
  if (!box.children.length) box.innerHTML = '<div class="prov-empty">没有匹配的供应商。</div>';
}
function presetCard(p) {
  const btn = document.createElement("button");
  btn.className = "preset-card";
  btn.innerHTML = `${iconBadge(p.icon, p.iconUrl, p.name)}<span class="pcol"><span class="pname">${esc(
    p.name,
  )}</span><span class="pnote">${esc(p.note || p.short || p.id)}</span></span>`;
  btn.addEventListener("click", () => openProviderForm({ preset: p }));
  return btn;
}

function applyPresetRegion(f, preset, r) {
  f.region = r ? r.id : null;
  f.urls = {
    chat: (r && r.chat) || preset.chat || "",
    responses: (r && r.responses) || preset.responses || "",
    anthropic: (r && r.anthropic) || preset.anthropic || "",
    gemini: (r && r.gemini) || preset.gemini || "",
  };
  f.kinds = new Set(["chat", "responses", "anthropic", "gemini"].filter((k) => f.urls[k]));
  f.catalog = (r && r.catalog) || preset.catalog || "";
  f.website = (r && r.website) || preset.website || "";
  f.keysUrl = (r && r.keysUrl) || preset.keysUrl || "";
  if (r && r.models) f.pickedFrom = r.models.slice();
}

function openProviderForm({ preset, provider, custom }) {
  const p = provider;
  const f = {
    id: null,
    presetId: null,
    name: "",
    icon: "generic",
    iconUrl: "",
    key: "",
    urls: { chat: "", responses: "", anthropic: "", gemini: "" },
    kinds: new Set(),
    models: [],
    pickedFrom: [],
    regions: [],
    region: null,
    catalog: "",
    website: "",
    keysUrl: "",
    headers: {},
    contextLimit: 0,
    noKey: false,
    _preset: preset || null,
  };
  if (p) {
    f.id = p.id;
    f.presetId = p.preset || null;
    f.name = p.name || p.id;
    f.icon = p.icon || "generic";
    f.iconUrl = p.iconUrl || "";
    f.key = p.key || "";
    for (const k of ["chat", "responses", "anthropic", "gemini"]) if (p[k]) f.urls[k] = p[k];
    f.kinds = new Set(["chat", "responses", "anthropic", "gemini"].filter((k) => f.urls[k]));
    f.models = (p.models || []).slice();
    f.pickedFrom = (p.pickedFrom || []).slice();
    f.catalog = p.catalog || "";
    f.website = p.website || "";
    f.keysUrl = p.keysUrl || "";
    f.headers = { ...(p.headers || {}) };
    f.contextLimit = p.contextLimit || 0;
    f.noKey = !!p.noKey;
    f.region = p.region || null;
    const pr = presets.find((x) => x.id === f.presetId);
    if (pr) {
      f._preset = pr;
      f.regions = pr.regions || [];
    }
  } else if (preset) {
    f.presetId = preset.id;
    f._preset = preset;
    f.name = preset.name || preset.id;
    f.icon = preset.icon || "generic";
    f.iconUrl = preset.iconUrl || "";
    f.catalog = preset.catalog || "";
    f.website = preset.website || "";
    f.keysUrl = preset.keysUrl || "";
    f.noKey = !!preset.noKey;
    f.regions = preset.regions || [];
    f.pickedFrom = (preset.models || []).slice();
    if (f.regions.length) applyPresetRegion(f, preset, f.regions[0]);
    else applyPresetRegion(f, preset, null);
  } else {
    f.kinds.add("chat");
  }
  formState = f;
  renderProviderForm();
  $("addProvPicker").classList.add("hidden");
  $("addProvForm").classList.remove("hidden");
  $("addProvBack").classList.remove("hidden");
  $("addProvTitle").textContent = f.id ? "编辑供应商" : preset ? `添加：${preset.name}` : "添加自定义供应商";
  $("addProvSave").textContent = f.id ? "保存" : "添加";
  $("addProvStatus").textContent = "";
  $("addProvModal").classList.remove("hidden");
}

function renderProviderForm() {
  const f = formState;
  if (!f) return;
  const box = $("addProvForm");
  const kindChips = apiKinds
    .map((k) => {
      const on = f.kinds.has(k.id) ? " on" : "";
      const dis = k.id === "systemone" ? " disabled" : "";
      return `<button type="button" class="chip${on}" data-kind="${k.id}"${dis} title="${esc(k.hint || "")}">${esc(
        k.label,
      )}</button>`;
    })
    .join("");
  const urlFields = apiKinds
    .filter((k) => f.kinds.has(k.id) && k.id !== "systemone")
    .map(
      (k) => `
      <div class="field">
        <label>${esc(k.label)} Base URL</label>
        <input type="text" data-url="${k.id}" value="${esc(f.urls[k.id] || "")}" placeholder="${esc(
          k.id === "anthropic" ? "https://api.anthropic.com" : "https://…/v1",
        )}">
        <span class="hint">${esc(k.hint || "")}</span>
      </div>`,
    )
    .join("");
  const regionField =
    f.regions && f.regions.length
      ? `<div class="field"><label>${esc((f._preset && f._preset.regionLabel) || "端点")}</label>
          <select id="pfRegion">${f.regions
            .map((r) => `<option value="${esc(r.id)}"${r.id === f.region ? " selected" : ""}>${esc(r.name || r.id)}</option>`)
            .join("")}</select></div>`
      : "";
  const pills = (f.pickedFrom || [])
    .slice(0, 300)
    .map(
      (m) =>
        `<button type="button" class="model-pill${f.models.includes(m) ? " on" : ""}" data-model="${esc(m)}">${esc(m)}</button>`,
    )
    .join("");
  const headerText = Object.entries(f.headers || {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  box.innerHTML = `
    <div class="field"><label>名称</label><input type="text" id="pfName" value="${esc(f.name)}" placeholder="例如 My Relay"></div>
    ${regionField}
    <div class="field"><label>接口类型</label><div class="chips" id="pfKinds">${kindChips}</div>
      <span class="hint">接口支持几种就选几种；本工具会用最先可用的那种。</span></div>
    ${urlFields}
    <div class="row"><button type="button" id="pfDetect">检测协议</button><span id="pfDetectResult" class="detect-result"></span></div>
    <div class="field"><label>API 密钥</label>
      <div class="row"><input type="password" id="pfKey" value="${esc(f.key)}" placeholder="${f.noKey ? "可留空" : "粘贴 API 密钥"}" style="flex:1"><button type="button" id="pfShowKey">显示</button></div>
      <span class="hint">保存在 ${esc(CONFIG_HINT)}，仅你本人可读。不读取 shell 里的任何内容。</span></div>
    <div class="field"><label>图标</label>
      <div class="row"><span id="pfIcon">${iconBadge(f.icon, f.iconUrl, f.name)}</span>
        <input type="text" id="pfIconId" list="iconList" value="${esc(f.icon)}" style="width:170px">
        <datalist id="iconList">${[...new Set(presets.map((p) => p.icon).filter(Boolean))]
          .map((i) => `<option value="${esc(i)}"></option>`)
          .join("")}</datalist>
        <button type="button" id="pfPickImg">选择图片…</button>
        <button type="button" id="pfClearImg">清除图片</button>
        <input type="file" id="pfFile" accept="image/*" class="hidden">
      </div></div>
    <div class="field"><label>模型</label>
      <div class="row"><input type="text" id="pfModels" value="${esc(f.models.join(", "))}" placeholder="模型 ID，逗号分隔，例如 gpt-5.5, claude-sonnet-5" style="flex:1"><button type="button" id="pfFetch">获取模型</button></div>
      <span class="hint" id="pfFetchHint">可选：用「获取模型」从供应商列表中勾选，或直接填写模型 ID。</span>
      <div class="model-box" id="pfPills">${pills}</div></div>
    <details class="adv"><summary>高级</summary><div class="adv-body">
      <div class="field"><label>请求头（每行 Key: Value）</label><textarea id="pfHeaders" rows="3" placeholder="X-Foo: bar">${esc(headerText)}</textarea></div>
      <div class="field"><label>上下文上限（tokens，可选）</label><input type="text" id="pfCtx" value="${f.contextLimit || ""}"></div>
    </div></details>`;

  $("pfName").addEventListener("input", (e) => {
    f.name = e.target.value;
    $("pfIcon").innerHTML = iconBadge(f.icon, f.iconUrl, f.name);
  });
  if ($("pfRegion")) {
    $("pfRegion").addEventListener("change", (e) => {
      const r = f._preset.regions.find((x) => x.id === e.target.value);
      applyPresetRegion(f, f._preset, r);
      renderProviderForm();
    });
  }
  box.querySelectorAll("#pfKinds .chip").forEach((c) =>
    c.addEventListener("click", () => {
      const k = c.dataset.kind;
      if (k === "systemone") return;
      if (f.kinds.has(k)) f.kinds.delete(k);
      else f.kinds.add(k);
      renderProviderForm();
    }),
  );
  box.querySelectorAll("input[data-url]").forEach((i) =>
    i.addEventListener("input", () => {
      f.urls[i.dataset.url] = i.value;
    }),
  );
  $("pfDetect").addEventListener("click", async () => {
    const el = $("pfDetectResult");
    const kind = [...f.kinds].find((k) => k !== "systemone");
    const base = kind ? f.urls[kind] : f.urls.chat || f.urls.anthropic || f.urls.responses || f.urls.gemini;
    if (!base) {
      el.innerHTML = '<span class="no">请先填写 Base URL</span>';
      return;
    }
    el.innerHTML = '<span class="no">检测中…</span>';
    try {
      const r = await apiJson("/api/providers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: base, key: f.key, kind }),
      });
      el.innerHTML = r.results
        .map((x) => `<span class="${x.ok ? "ok" : "no"}">${x.ok ? "✓" : "✗"} ${esc(x.kind)} · ${esc(x.note)}</span>`)
        .join("");
    } catch (e) {
      el.innerHTML = `<span class="no">检测失败：${esc(e.message)}</span>`;
    }
  });
  $("pfShowKey").addEventListener("click", () => {
    const i = $("pfKey");
    const show = i.type === "password";
    i.type = show ? "text" : "password";
    $("pfShowKey").textContent = show ? "隐藏" : "显示";
  });
  $("pfKey").addEventListener("input", (e) => (f.key = e.target.value));
  $("pfIconId").addEventListener("input", (e) => {
    f.icon = e.target.value || "generic";
    $("pfIcon").innerHTML = iconBadge(f.icon, f.iconUrl, f.name);
  });
  $("pfPickImg").addEventListener("click", () => $("pfFile").click());
  $("pfFile").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 400000) {
      alert("图片太大（>400KB），请换一张更小的。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      f.iconUrl = String(reader.result);
      $("pfIcon").innerHTML = iconBadge(f.icon, f.iconUrl, f.name);
    };
    reader.readAsDataURL(file);
  });
  $("pfClearImg").addEventListener("click", () => {
    f.iconUrl = "";
    $("pfIcon").innerHTML = iconBadge(f.icon, f.iconUrl, f.name);
  });
  $("pfModels").addEventListener("input", (e) => {
    f.models = e.target.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  });
  $("pfFetch").addEventListener("click", async () => {
    const hint = $("pfFetchHint");
    hint.textContent = "正在获取模型…";
    try {
      const body = f.id
        ? { id: f.id }
        : {
            chat: f.kinds.has("chat") ? f.urls.chat : "",
            responses: f.kinds.has("responses") ? f.urls.responses : "",
            anthropic: f.kinds.has("anthropic") ? f.urls.anthropic : "",
            gemini: f.kinds.has("gemini") ? f.urls.gemini : "",
            key: f.key,
            headers: f.headers,
          };
      const r = await apiJson("/api/providers/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.models && r.models.length) {
        f.pickedFrom = r.models.slice();
        hint.textContent = `获取到 ${r.models.length} 个模型，点选要用的。`;
        renderProviderForm();
      } else {
        hint.textContent =
          "没有获取到模型" + (r.errors && r.errors.length ? "：" + r.errors[0] : "") + "，可直接手填。";
      }
    } catch (e) {
      hint.textContent = "获取失败：" + e.message;
    }
  });
  box.querySelectorAll("#pfPills .model-pill").forEach((pill) =>
    pill.addEventListener("click", () => {
      const m = pill.dataset.model;
      if (f.models.includes(m)) f.models = f.models.filter((x) => x !== m);
      else f.models.push(m);
      renderProviderForm();
    }),
  );
  $("pfHeaders").addEventListener("input", (e) => {
    const h = {};
    for (const line of e.target.value.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    f.headers = h;
  });
  $("pfCtx").addEventListener("input", (e) => {
    f.contextLimit = Number(e.target.value) || 0;
  });
}

function providerPayload(f) {
  return {
    preset: f.presetId || undefined,
    region: f.region || undefined,
    name: f.name.trim(),
    icon: f.icon || "generic",
    iconUrl: f.iconUrl || null,
    key: f.key,
    chat: f.kinds.has("chat") ? f.urls.chat.trim() : "",
    responses: f.kinds.has("responses") ? f.urls.responses.trim() : "",
    anthropic: f.kinds.has("anthropic") ? f.urls.anthropic.trim() : "",
    gemini: f.kinds.has("gemini") ? f.urls.gemini.trim() : "",
    models: f.models,
    catalog: f.catalog || "",
    website: f.website || "",
    keysUrl: f.keysUrl || "",
    headers: f.headers || {},
    contextLimit: Number(f.contextLimit) || 0,
  };
}

async function saveProviderForm() {
  const f = formState;
  if (!f) return;
  const payload = providerPayload(f);
  if (!payload.name) {
    $("addProvStatus").textContent = "请填写名称";
    return;
  }
  $("addProvStatus").textContent = "保存中…";
  try {
    if (f.id) {
      await apiJson("/api/providers/" + encodeURIComponent(f.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      const r = await apiJson("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!prefs.defaultProvider && r.provider) {
        await apiJson("/api/prefs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            defaultProvider: r.provider.id,
            defaultModel: r.provider.models[0] || r.provider.pickedFrom[0] || "",
          }),
        });
      }
    }
    await loadProviders();
    closeAddProvider();
    renderProvList();
    $("provStatus").textContent = "已保存 · " + CONFIG_HINT;
  } catch (e) {
    $("addProvStatus").textContent = "保存失败：" + e.message;
  }
}

// ---- 事件绑定 ----
function initAi() {
  loadProviders().catch((e) => console.warn("providers:", e));
}

$("openProviders").addEventListener("click", openProviders);
$("provAdd").addEventListener("click", () => openAddProvider());
$("provClose").addEventListener("click", closeProviders);
$("provCloseBtn").addEventListener("click", closeProviders);
$("provSearch").addEventListener("input", renderProvList);
$("provModal").addEventListener("click", (e) => {
  if (e.target === $("provModal")) closeProviders();
});

$("addProvClose").addEventListener("click", closeAddProvider);
$("addProvCancel").addEventListener("click", closeAddProvider);
$("addProvSave").addEventListener("click", saveProviderForm);
$("addProvBack").addEventListener("click", () => {
  $("addProvForm").classList.add("hidden");
  $("addProvPicker").classList.remove("hidden");
  $("addProvBack").classList.add("hidden");
  $("addProvTitle").textContent = "添加供应商";
  $("addProvSave").textContent = "添加";
  formState = null;
});
$("presetSearch").addEventListener("input", renderPicker);
$("addProvModal").addEventListener("click", (e) => {
  if (e.target === $("addProvModal")) closeAddProvider();
});

$("aiSummarizeSelected").addEventListener("click", () => {
  const ids = selectedIds();
  if (!ids.length) {
    setStatus("请先勾选要总结的会话。", "err");
    return;
  }
  if (ids.length === 1) {
    const s = sessions.find((x) => x.id === ids[0]) || allSessions.find((x) => x.id === ids[0]);
    if (s) return aiSummarizeSingle(s);
  }
  aiBatchSummarize();
});
$("aiBatch").addEventListener("click", aiBatchSummarize);
$("aiAsk").addEventListener("click", aiAskSessions);
$("aiSend").addEventListener("click", aiSendQuestion);
$("aiQuestion").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    aiSendQuestion();
  }
});
$("aiProvider").addEventListener("change", () => {
  renderAiModels();
  updateAiCurrent();
});
$("aiModel").addEventListener("change", updateAiCurrent);
$("aiClose").addEventListener("click", closeAiPanel);
$("aiCloseBtn").addEventListener("click", closeAiPanel);
$("aiStop").addEventListener("click", () => {
  if (ai.ctrl) ai.ctrl.abort();
});
$("aiModal").addEventListener("click", (e) => {
  if (e.target === $("aiModal")) closeAiPanel();
});
