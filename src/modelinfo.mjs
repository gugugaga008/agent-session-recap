// Model metadata — context window, max output, reasoning, image input.
//
// Two upstream sources are used:
//   1. models.dev (https://models.dev/api.json) — a catalog of every vendor's
//      models; cached on disk for a day.
//   2. the provider's own /models response, when it carries the fields
//      (OpenRouter-style context_length / input_modalities / …), which is
//      more accurate for a relay.
//
// Everything is optional and the user can edit it by hand; nothing here is
// required for a call to work.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getConfigDir } from "./paths.mjs";

export const CATALOG_URL = "https://models.dev/api.json";
const TTL_MS = 24 * 60 * 60 * 1000;

function cachePath() {
  return path.join(getConfigDir(), "models-dev.json");
}

let memory = null; // { catalog, fetchedAt, fromCache, error }

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** models.dev's own model record → our meta. */
export function metaFromCatalogModel(m) {
  if (!m || typeof m !== "object") return null;
  const input = (m.modalities && m.modalities.input) || [];
  return {
    context: num(m.limit && m.limit.context),
    maxOutput: num(m.limit && m.limit.output),
    reasoning: !!m.reasoning,
    vision: Array.isArray(input) ? input.includes("image") : !!m.attachment,
    toolCall: !!m.tool_call,
    catalogName: typeof m.name === "string" ? m.name : undefined,
    source: "models.dev",
  };
}

/**
 * A provider's own /models entry → our meta. Field names differ per vendor,
 * so the common ones are all tried; `null` when the entry says nothing.
 */
export function metaFromUpstreamModel(m) {
  if (!m || typeof m !== "object") return null;
  const ctx = num(
    m.context_length ?? m.context_window ?? m.context ??
      (m.limit && m.limit.context) ?? m.max_context_length ?? m.max_model_len,
  );
  const out = num(
    (m.top_provider && m.top_provider.max_completion_tokens) ??
      m.max_completion_tokens ?? m.max_output_tokens ?? (m.limit && m.limit.output) ?? m.max_tokens,
  );
  let mods = m.architecture && m.architecture.input_modalities;
  if (!Array.isArray(mods)) mods = m.modalities && m.modalities.input;
  if (!Array.isArray(mods)) mods = m.input_modalities;
  if (!Array.isArray(mods) && Array.isArray(m.capabilities)) mods = m.capabilities;
  let vision;
  if (Array.isArray(mods)) vision = mods.includes("image") || mods.includes("vision");
  else if (typeof m.attachment === "boolean") vision = m.attachment;
  else if (typeof m.vision === "boolean") vision = m.vision;
  let reasoning;
  const params = m.supported_parameters || m.supported_params;
  if (Array.isArray(params)) reasoning = params.includes("reasoning") || params.includes("include_reasoning");
  else if (typeof m.reasoning === "boolean") reasoning = m.reasoning;
  if (ctx === undefined && out === undefined && vision === undefined && reasoning === undefined) return null;
  return {
    ...(ctx !== undefined ? { context: ctx } : {}),
    ...(out !== undefined ? { maxOutput: out } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    source: "upstream",
  };
}

/** Load the models.dev catalog, from the on-disk cache when fresh. */
export async function loadCatalog({ force = false, timeout = 60000 } = {}) {
  if (!force && memory && Date.now() - Date.parse(memory.fetchedAt) < TTL_MS) return memory;

  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
  } catch {
    /* no cache yet */
  }
  const fresh = cached && cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS;
  if (!force && fresh) {
    memory = { catalog: cached.data, fetchedAt: cached.fetchedAt, fromCache: true };
    return memory;
  }
  try {
    const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const fetchedAt = new Date().toISOString();
    await fsp.mkdir(getConfigDir(), { recursive: true });
    await fsp.writeFile(cachePath(), JSON.stringify({ fetchedAt, data }), "utf8");
    memory = { catalog: data, fetchedAt, fromCache: false };
    return memory;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (cached && cached.data) {
      memory = { catalog: cached.data, fetchedAt: cached.fetchedAt, fromCache: true, error: msg };
      return memory;
    }
    throw new Error("无法获取 models.dev 目录：" + msg);
  }
}

const indexes = new WeakMap();

function indexOf(catalog) {
  let idx = indexes.get(catalog);
  if (idx) return idx;
  const byProvider = new Map();
  const global = new Map();
  for (const pid of Object.keys(catalog)) {
    const p = catalog[pid];
    if (!p || !p.models) continue;
    byProvider.set(pid, p.models);
    for (const mid of Object.keys(p.models)) {
      if (!global.has(mid)) global.set(mid, { providerId: pid, model: p.models[mid] });
    }
  }
  idx = { byProvider, global };
  indexes.set(catalog, idx);
  return idx;
}

/**
 * Find a model's metadata. `catalogIds` is the provider's catalog id list
 * ("deepseek", "alibaba", or several, comma-separated); exact matches
 * there win, then a `vendor/model` prefix, then a global search.
 */
export function lookupModel(catalog, catalogIds, modelId) {
  if (!catalog || !modelId) return null;
  const { byProvider, global } = indexOf(catalog);
  const ids = String(catalogIds || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const cid of ids) {
    const models = byProvider.get(cid);
    if (models && models[modelId]) return metaFromCatalogModel(models[modelId]);
  }
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const pfx = modelId.slice(0, slash);
    const rest = modelId.slice(slash + 1);
    const models = byProvider.get(pfx);
    if (models && models[rest]) return metaFromCatalogModel(models[rest]);
  }
  const hit = global.get(modelId);
  if (hit) return metaFromCatalogModel(hit.model);
  return null;
}

/**
 * Metadata for a list of model ids: the provider's own /models entries first
 * (they describe this very endpoint), models.dev filling the gaps, and the
 * user's own values left untouched.
 * @returns {Promise<{meta:Object, catalog:{fetchedAt:string,fromCache:boolean,error?:string}}>}
 */
export async function enrichModels(provider, models, { upstream = {}, force = false, existing = {} } = {}) {
  let catalog = {};
  let info = { fetchedAt: null, fromCache: true };
  try {
    const c = await loadCatalog({ force });
    catalog = c.catalog;
    info = { fetchedAt: c.fetchedAt, fromCache: c.fromCache, ...(c.error ? { error: c.error } : {}) };
  } catch (e) {
    info = { fetchedAt: null, fromCache: false, error: String((e && e.message) || e) };
  }

  const meta = {};
  for (const id of models) {
    const fromUp = metaFromUpstreamModel(upstream[id]);
    const fromCatalog = lookupModel(catalog, provider && provider.catalog, id);
    const here = existing[id] || {};
    const merged = { ...(fromCatalog || {}), ...(fromUp || {}), ...here };
    // user-edited fields win; keep a source label
    if (here.context !== undefined || here.maxOutput !== undefined || here.reasoning !== undefined || here.vision !== undefined) {
      merged.source = "manual";
    } else {
      merged.source = fromUp ? "upstream" : fromCatalog ? "models.dev" : "";
    }
    for (const k of Object.keys(merged)) if (merged[k] === undefined || merged[k] === "") delete merged[k];
    if (Object.keys(merged).length) meta[id] = merged;
  }
  return { meta, catalog: info };
}
