// AI provider management. A provider is one entry of providers.json, with the
// shape mainstream provider managers use:
//
//   { id, name, icon, preset, key, chat, responses, anthropic, gemini,
//     models: [], pickedFrom: [], catalog, website, keysUrl, off, noModels }
//
// The file lives at ~/.config/agent-session-recap/providers.json and only
// this user can read it. Nothing is ever read from shell environment keys:
// what you add here is what is used.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "./paths.mjs";
import { metaFromUpstreamModel } from "./modelinfo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESETS_FILE = path.join(__dirname, "presets.json");

/** Base URL shapes a provider can speak, in the order the editor shows them. */
export const API_KINDS = [
  { id: "chat", label: "OpenAI 兼容", hint: "以 /v1 结尾，自动拼 /chat/completions", suffix: "/chat/completions" },
  { id: "responses", label: "OpenAI Responses", hint: "以 /v1 结尾，Codex 的原生接口", suffix: "/responses" },
  { id: "anthropic", label: "Anthropic 兼容", hint: "根地址，即 ANTHROPIC_BASE_URL", suffix: "/v1/messages" },
  { id: "gemini", label: "Gemini 兼容", hint: "以 /v1beta 结尾", suffix: "/models/{model}:generateContent" },
  { id: "systemone", label: "System One", hint: "决策模型接口，本工具不调用", suffix: "" },
];

// ---------------------------------------------------------------- config

export { getConfigDir };

export function providersPath() {
  return path.join(getConfigDir(), "providers.json");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The whole store: `{ providers: [...], prefs: {...} }`. */
export function loadStore() {
  const data = readJsonSafe(providersPath());
  const store = { providers: [], prefs: {} };
  if (data && Array.isArray(data.providers)) store.providers = data.providers;
  if (data && data.prefs && typeof data.prefs === "object") store.prefs = data.prefs;
  return store;
}

async function saveStore(store) {
  const dir = getConfigDir();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = providersPath();
  const body = JSON.stringify({ providers: store.providers, prefs: store.prefs || {} }, null, 2) + "\n";
  try {
    await fsp.copyFile(file, file + ".bak");
  } catch {
    /* first write */
  }
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  await fsp.rename(tmp, file);
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    /* windows */
  }
}

/** UI preferences (default provider/model, language). */
export function loadPrefs() {
  return loadStore().prefs || {};
}

export async function savePrefs(patch) {
  const store = loadStore();
  store.prefs = { ...(store.prefs || {}), ...patch };
  await saveStore(store);
  return store.prefs;
}

// ---------------------------------------------------------------- presets

let presetCache = null;

export function loadPresets() {
  if (presetCache) return presetCache;
  const data = readJsonSafe(PRESETS_FILE);
  presetCache = data && Array.isArray(data.presets) ? data.presets : [];
  return presetCache;
}

export function findPreset(id) {
  if (!id) return null;
  return loadPresets().find((p) => p.id === id) || null;
}

/** Presets grouped so the add sheet lists like kinds together. */
export const PRESET_GROUPS = [
  { kind: "partner", label: "合作伙伴", note: "官方合作的服务" },
  { kind: "vendor", label: "供应商", note: "模型厂商的 API" },
  { kind: "relay", label: "中转", note: "一个密钥，多家模型" },
  { kind: "local", label: "本机", note: "跑在这台机器上的服务" },
  { kind: "remote", label: "另一台电脑", note: "在它的局域网上共享" },
];

// ---------------------------------------------------------------- helpers

function slug(name) {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "provider";
}

function uniqueId(store, base) {
  const taken = new Set(store.providers.map((p) => p.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function maskKey(key) {
  if (!key) return "";
  const k = String(key);
  if (k.length <= 10) return k.slice(0, 2) + "…" + k.slice(-2);
  return k.slice(0, 4) + "…" + k.slice(-4);
}

function publicProvider(p) {
  return {
    id: p.id,
    name: p.name || p.id,
    icon: p.icon || "generic",
    iconUrl: p.iconUrl || null,
    preset: p.preset || null,
    keyMasked: maskKey(p.key),
    hasKey: !!p.key,
    chat: p.chat || "",
    responses: p.responses || "",
    anthropic: p.anthropic || "",
    gemini: p.gemini || "",
    decide: p.decide || "",
    models: Array.isArray(p.models) ? p.models : [],
    pickedFrom: Array.isArray(p.pickedFrom) ? p.pickedFrom : [],
    modelMeta: p.modelMeta && typeof p.modelMeta === "object" ? p.modelMeta : {},
    catalog: p.catalog || "",
    website: p.website || "",
    keysUrl: p.keysUrl || "",
    off: !!p.off,
    noModels: !!p.noModels,
    noKey: !!p.noKey,
    region: p.region || null,
    headers: p.headers && typeof p.headers === "object" ? p.headers : {},
    contextLimit: Number(p.contextLimit) || 0,
  };
}

/** Providers for the UI: keys masked unless `reveal` is set. */
export function listProviders({ reveal = false } = {}) {
  return loadStore().providers.map((p) => {
    const pub = publicProvider(p);
    if (reveal) pub.key = p.key || "";
    return pub;
  });
}

/** The full provider record (with key) for a call. */
export function getProvider(id) {
  return loadStore().providers.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------- CRUD

function fromPreset(preset, { key, models, region, id, name }) {
  let chat = preset.chat || "";
  let responses = preset.responses || "";
  let anthropic = preset.anthropic || "";
  let gemini = preset.gemini || "";
  let decide = preset.decide || "";
  let keysUrl = preset.keysUrl || "";
  let website = preset.website || "";
  let catalog = preset.catalog || "";
  let regionLabel = preset.regionLabel || null;
  let picked = preset.models || [];
  if (region && Array.isArray(preset.regions)) {
    const r = preset.regions.find((x) => x.id === region);
    if (r) {
      chat = r.chat || chat;
      responses = r.responses || responses;
      anthropic = r.anthropic || anthropic;
      gemini = r.gemini || gemini;
      decide = r.decide || decide;
      keysUrl = r.keysUrl || keysUrl;
      website = r.website || website;
      catalog = r.catalog || catalog;
      if (r.models) picked = r.models;
    }
  }
  return {
    id: id || slug(preset.id),
    name: name || preset.name || preset.id,
    icon: preset.icon || "generic",
    iconUrl: preset.iconUrl || null,
    preset: preset.id,
    key: key || "",
    chat,
    responses,
    anthropic,
    gemini,
    decide,
    catalog,
    website,
    keysUrl,
    region: region || null,
    regionLabel,
    models: Array.isArray(models) ? models : [],
    pickedFrom: Array.isArray(picked) ? picked : [],
    modelMeta: input.modelMeta && typeof input.modelMeta === "object" ? input.modelMeta : {},
    noKey: !!preset.noKey,
    off: false,
  };
}

function fromCustom(input) {
  return {
    id: input.id,
    name: input.name,
    icon: input.icon || "generic",
    iconUrl: input.iconUrl || null,
    preset: null,
    key: input.key || "",
    chat: input.chat || "",
    responses: input.responses || "",
    anthropic: input.anthropic || "",
    gemini: input.gemini || "",
    decide: input.decide || "",
    catalog: input.catalog || "",
    website: input.website || "",
    keysUrl: input.keysUrl || "",
    models: Array.isArray(input.models) ? input.models : [],
    pickedFrom: [],
    modelMeta: input.modelMeta && typeof input.modelMeta === "object" ? input.modelMeta : {},
    noKey: !!input.noKey,
    headers: input.headers && typeof input.headers === "object" ? input.headers : {},
    off: false,
  };
}

/** Add a provider from a preset id, or a custom one (name + base URLs). */
export async function addProvider(input) {
  const store = loadStore();
  let rec;
  if (input.preset) {
    const preset = findPreset(input.preset);
    if (!preset) throw new Error(`未知的预设供应商 "${input.preset}"`);
    rec = fromPreset(preset, input);
    rec.id = uniqueId(store, input.id || slug(preset.id));
  } else {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("请填写名称");
    if (!input.chat && !input.anthropic && !input.responses && !input.gemini && !input.decide) {
      throw new Error("至少填写一个接口地址");
    }
    rec = fromCustom({ ...input, name });
    rec.id = uniqueId(store, input.id || slug(name));
  }
  if (input.models === undefined && rec.models.length === 0 && !rec.noKey) {
    // leave empty; the UI can fetch them
  }
  store.providers.push(rec);
  await saveStore(store);
  return publicProvider(rec);
}

/** Patch an existing provider. Unknown fields are ignored. */
export async function updateProvider(id, patch) {
  const store = loadStore();
  const p = store.providers.find((x) => x.id === id);
  if (!p) throw new Error(`未找到供应商 "${id}"`);
  const allowed = [
    "name", "icon", "iconUrl", "key", "chat", "responses", "anthropic", "gemini", "decide",
    "catalog", "website", "keysUrl", "models", "pickedFrom", "modelMeta", "off", "noModels", "noKey",
    "headers", "region", "contextLimit",
  ];
  for (const k of allowed) {
    if (patch[k] !== undefined) p[k] = patch[k];
  }
  await saveStore(store);
  return publicProvider(p);
}

export async function removeProvider(id) {
  const store = loadStore();
  const before = store.providers.length;
  store.providers = store.providers.filter((p) => p.id !== id);
  if (store.providers.length === before) throw new Error(`未找到供应商 "${id}"`);
  await saveStore(store);
  return { ok: true };
}

// ---------------------------------------------------------------- endpoints

/** Which base URL a provider speaks, and in which API. */
export function endpointsOf(p) {
  const out = [];
  if (p.chat) out.push({ kind: "chat", url: p.chat });
  if (p.responses) out.push({ kind: "responses", url: p.responses });
  if (p.anthropic) out.push({ kind: "anthropic", url: p.anthropic });
  if (p.gemini) out.push({ kind: "gemini", url: p.gemini });
  return out;
}

function joinUrl(base, suffix) {
  return String(base).replace(/\/+$/, "") + suffix;
}

function headersFor(p, kind) {
  const h = { "Content-Type": "application/json" };
  const custom = p.headers && typeof p.headers === "object" ? p.headers : {};
  Object.assign(h, custom);
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

/** All the request shapes a provider can be called with, cheapest first. */
export function callTargets(p) {
  const targets = [];
  if (p.chat) targets.push({ kind: "chat", url: joinUrl(p.chat, "/chat/completions") });
  if (p.anthropic) targets.push({ kind: "anthropic", url: joinUrl(p.anthropic, "/v1/messages") });
  if (p.gemini) targets.push({ kind: "gemini", url: p.gemini });
  if (p.responses) targets.push({ kind: "responses", url: joinUrl(p.responses, "/responses") });
  return targets;
}

async function reqJson(url, { method = "GET", headers = {}, body, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /models in whatever shape the endpoint serves. */
export async function fetchModels(p) {
  const found = [];
  const upstream = {};
  const errors = [];
  const add = (id, raw) => {
    const s = String(id);
    if (!s) return;
    found.push(s);
    if (raw && typeof raw === "object") upstream[s] = raw;
  };
  const tryOpenAI = async (base) => {
    if (!base) return;
    const url = joinUrl(base, "/models");
    const r = await reqJson(url, { headers: headersFor(p, "chat") });
    if (r.ok && r.json) {
      const list = r.json.data || r.json.models || [];
      for (const m of list) add(m.id || m.name || m.model, m);
    } else {
      errors.push(`${url}: HTTP ${r.status}`);
    }
  };
  const tryAnthropic = async () => {
    if (!p.anthropic) return;
    const url = joinUrl(p.anthropic, "/v1/models");
    const r = await reqJson(url, { headers: headersFor(p, "anthropic") });
    if (r.ok && r.json) {
      for (const m of r.json.data || []) add(m.id || m.name, m);
    } else {
      errors.push(`${url}: HTTP ${r.status}`);
    }
  };
  const tryGemini = async () => {
    if (!p.gemini) return;
    const url = joinUrl(p.gemini, "/models");
    const r = await reqJson(url, { headers: headersFor(p, "gemini") });
    if (r.ok && r.json) {
      for (const m of r.json.models || []) add(String(m.name || "").replace(/^models\//, ""), m);
    } else {
      errors.push(`${url}: HTTP ${r.status}`);
    }
  };

  if (p.chat) await tryOpenAI(p.chat);
  if (p.responses && p.responses !== p.chat) await tryOpenAI(p.responses);
  if (p.anthropic) await tryAnthropic();
  if (p.gemini) await tryGemini();

  const models = [...new Set(found)];
  if (models.length && p.id && p.id !== "__adhoc__") {
    // only a saved provider can keep its list
    try {
      if (getProvider(p.id)) await updateProvider(p.id, { pickedFrom: models });
    } catch {
      /* ignore */
    }
  }
  return { models, upstream, errors, meta: metaFromUpstreamModels(upstream) };
}

/** Upstream /models entries → `{ modelId: meta }`, dropping the empty ones. */
export function metaFromUpstreamModels(upstream) {
  const out = {};
  for (const [id, raw] of Object.entries(upstream || {})) {
    const m = metaFromUpstreamModel(raw);
    if (m) out[id] = m;
  }
  return out;
}

/**
 * "检测协议": probe a base URL to learn which API shapes it answers.
 *
 * A vendor that validates the model name answers 404 to a made-up probe model
 * (some gateways do), so a 404 carrying a JSON error body still
 * counts as "this API is here"; an HTML 404 from a wrong host does not. The
 * models list is used as a second opinion.
 */
export async function detectProtocol({ baseUrl, key, kind, model }) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("请先填写 Base URL");
  const p = { key: key || "" };
  const probeModel = model || "__probe__";
  const body = {
    chat: { model: probeModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    responses: { model: probeModel, input: "ping", max_output_tokens: 1 },
    anthropic: { model: probeModel, max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
  };
  const pathFor = { chat: "/chat/completions", responses: "/responses", anthropic: "/v1/messages" };
  const listFor = { chat: "/models", responses: "/models", anthropic: "/v1/models", gemini: "/models" };
  const kinds = kind ? [kind] : ["chat", "responses", "anthropic", "gemini"];
  const results = [];
  for (const k of kinds) {
    if (k === "gemini") {
      const r = await reqJson(joinUrl(base, "/models"), { headers: headersFor(p, "gemini"), timeout: 12000 });
      results.push(verdict(k, r));
      continue;
    }
    const r = await reqJson(joinUrl(base, pathFor[k]), {
      method: "POST",
      headers: headersFor(p, k),
      body: body[k],
      timeout: 15000,
    });
    const v = verdict(k, r);
    if (!v.ok) {
      const lr = await reqJson(joinUrl(base, listFor[k]), { headers: headersFor(p, k), timeout: 10000 });
      if (listOk(lr)) {
        v.ok = true;
        v.note = "接口存在（模型列表可读）";
      }
    }
    results.push(v);
  }
  return { baseUrl: base, results };
}

function listOk(r) {
  return r.status !== 0 && r.status < 500 && r.status !== 404 && r.status !== 405;
}

function verdict(kind, r) {
  const jsonError = !!(r.json && typeof r.json === "object" && (r.json.error || r.json.message));
  const notFound = r.status === 404 || r.status === 405;
  const ok = r.status !== 0 && r.status < 500 && (!notFound || jsonError);
  let note;
  if (r.status === 0) note = "无法连接";
  else if (r.ok && !jsonError) note = "可用";
  else if (r.status === 401 || r.status === 403) note = "接口存在，密钥未通过";
  else if (notFound) note = jsonError ? "接口存在，但不认这个模型名" : "该协议不存在";
  else if (r.status === 429) note = "接口存在，被限流";
  else {
    const msg = r.json && (r.json.error?.message || r.json.message || r.json.error);
    note = `HTTP ${r.status}${msg ? " · " + String(msg).slice(0, 140) : ""}`;
  }
  return { kind, ok, status: r.status, note };
}
