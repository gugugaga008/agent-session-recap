// Generates src/presets.json — the "add provider" catalog — from magpie's
// own source, so this project doesn't reinvent the vendor list.
//
// Source: https://github.com/yetone/magpie
//   internal/provider/presets.go   built-in vendors, relays, local servers
//   https://usemagpie.ai/api/partners   the sponsor/partner cards
//
// Usage:
//   node scripts/gen-presets.mjs [path-to-magpie-checkout] [--no-partners]
//
// The magpie checkout is only needed when regenerating. The committed
// src/presets.json is what the app reads at runtime.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const args = process.argv.slice(2);
const noPartners = args.includes("--no-partners");
const srcArg = args.find((a) => !a.startsWith("--"));
const MAGPIE = srcArg || process.env.MAGPIE_SRC || path.join(ROOT, "..", "magpie");
const PRESETS_GO = path.join(MAGPIE, "internal", "provider", "presets.go");

// ---------------------------------------------------------------- helpers

const CONSTS = {
  VertexPreset: "google-vertex",
  AzurePreset: "azure",
  OMLXPreset: "omlx",
  MLXServePreset: "mlx-serve",
  RemoteMagpiePreset: "remote-magpie",
};

const KIND = {
  KindVendor: "vendor",
  KindRelay: "relay",
  KindLocal: "local",
  KindRemote: "remote",
  KindPartner: "partner",
};

/** Remove Go line comments, leaving string contents (URLs!) intact. */
function stripComments(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

/** Index of the matching close brace for the open brace at `start`. */
function matchBrace(text, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every `{...}` at the top level of `text`. */
function topLevelBraces(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const end = matchBrace(text, i);
      if (end < 0) break;
      out.push(text.slice(i + 1, end));
      i = end + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** Read one value that starts at `idx`: string, bool, number, call, ident. */
function readValue(text, idx) {
  while (text[idx] === " " || text[idx] === "\t" || text[idx] === "\n") idx++;
  const c = text[idx];
  if (c === '"') {
    let s = "";
    let i = idx + 1;
    while (i < text.length) {
      if (text[i] === "\\") {
        s += text[i + 1] === "n" ? "\n" : text[i + 1];
        i += 2;
        continue;
      }
      if (text[i] === '"') break;
      s += text[i++];
    }
    return { value: s, end: i + 1 };
  }
  if (text.startsWith("true", idx)) return { value: true, end: idx + 4 };
  if (text.startsWith("false", idx)) return { value: false, end: idx + 5 };
  const m = /^[A-Za-z_][\w.]*/.exec(text.slice(idx));
  if (!m) return { value: null, end: idx };
  const name = m[0];
  let end = idx + name.length;
  while (text[end] === " ") end++;
  if (text[end] === "(") {
    const close = matchParen(text, end);
    const argsText = text.slice(end + 1, close);
    return { value: { call: name, args: readArgs(argsText) }, end: close + 1 };
  }
  if (CONSTS[name]) return { value: CONSTS[name], end };
  return { value: name, end };
}

function matchParen(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

function readArgs(text) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") {
        cur += c + text[i + 1];
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      cur += c;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Resolve magpie's endpoint helper functions to plain URLs. */
function callValue(call) {
  const a = call.args.map((x) => x.replace(/^"|"$/g, ""));
  switch (call.call) {
    case "bedrockChat":
      return `https://bedrock-runtime.${a[0]}.amazonaws.com/openai/v1`;
    case "bedrockAnthropic":
      return `https://bedrock-runtime.${a[0]}.amazonaws.com/anthropic`;
    case "qwenCloudChat":
      return `https://${a[0]}.maas.qwencloudapi.com/compatible-mode/v1`;
    case "qwenCloudAnthropic":
      return `https://${a[0]}.maas.qwencloudapi.com/apps/anthropic`;
    case "mantleOpenAIBase":
      return `https://bedrock-mantle.${a[0]}.api.aws/v1`;
    case "mantleAnthropic":
      return `https://bedrock-mantle.${a[0]}.api.aws/anthropic`;
    case "bailianWorkspace":
      return `https://{WorkspaceId}.${a[0]}.maas.aliyuncs.com/compatible-mode/v1`;
    default:
      return null;
  }
}

function regionsForCall(call) {
  const ids = call.args.map((x) => x.replace(/^"|"$/g, ""));
  const one = (id) => {
    if (call.call === "bedrockRegions")
      return {
        id,
        name: id,
        chat: `https://bedrock-runtime.${id}.amazonaws.com/openai/v1`,
        responses: `https://bedrock-runtime.${id}.amazonaws.com/openai/v1`,
        anthropic: `https://bedrock-runtime.${id}.amazonaws.com/anthropic`,
      };
    if (call.call === "mantleRegions")
      return {
        id,
        name: id,
        chat: `https://bedrock-mantle.${id}.api.aws/v1`,
        responses: `https://bedrock-mantle.${id}.api.aws/v1`,
        anthropic: `https://bedrock-mantle.${id}.api.aws/anthropic`,
      };
    if (call.call === "qwenCloudRegions")
      return {
        id,
        name: id,
        chat: `https://${id}.maas.qwencloudapi.com/compatible-mode/v1`,
        anthropic: `https://${id}.maas.qwencloudapi.com/apps/anthropic`,
      };
    return { id, name: id };
  };
  return ids.map(one);
}

// ---------------------------------------------------------------- parsing

const SCALARS = [
  "ID", "Name", "Short", "Icon", "Kind", "Chat", "Responses", "Anthropic", "Gemini",
  "Decide", "Catalog", "Website", "KeysURL", "SiteHost", "Note", "KeyHint",
  "Endpoint", "EndpointHint", "EndpointNeeded", "RegionLabel", "Only",
];
const BOOLS = ["NoKey", "Sponsored", "KeyPlans", "SplitAccounts", "NoList", "Hosts", "Lists"];

const ARRAY_STOP = ["Regions:", "Models:", "HeaderHints:", "Embeddings:", "Rerankers:", "Drawers:", "Videos:", "Images:"];

function firstIndexOf(text, needles) {
  let best = -1;
  for (const n of needles) {
    const i = text.indexOf(n);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}

const KEY = {
  ID: "id", Name: "name", Short: "short", Icon: "icon", Kind: "kind",
  Chat: "chat", Responses: "responses", Anthropic: "anthropic", Gemini: "gemini",
  Decide: "decide", Catalog: "catalog", Website: "website", KeysURL: "keysUrl",
  SiteHost: "siteHost", Note: "note", KeyHint: "keyHint", Endpoint: "endpoint",
  EndpointHint: "endpointHint", EndpointNeeded: "endpointNeeded", RegionLabel: "regionLabel",
  Only: "only", NoKey: "noKey", Sponsored: "sponsored", KeyPlans: "keyPlans",
  SplitAccounts: "splitAccounts", NoList: "noList", Hosts: "hosts", Lists: "lists",
};

function parseScalars(text, target) {
  for (const f of SCALARS) {
    const re = new RegExp(`(?:^|[\\s,{])${f}:\\s*`, "m");
    const m = re.exec(text);
    if (!m) continue;
    const at = m.index + m[0].length;
    const { value } = readValue(text, at);
    if (value && typeof value === "object" && value.call) {
      const v = callValue(value);
      if (v != null) target[KEY[f]] = v;
    } else if (typeof value === "string") {
      if (f === "Kind") target.kind = KIND[value] || value;
      else target[KEY[f]] = value;
    }
  }
  for (const f of BOOLS) {
    const re = new RegExp(`(?:^|[\\s,{])${f}:\\s*(true|false)`, "m");
    const m = re.exec(text);
    if (m) target[KEY[f]] = m[1] === "true";
  }
  return target;
}

function parseStringList(text) {
  const open = text.indexOf("{");
  if (open < 0) return [];
  const close = matchBrace(text, open);
  const body = text.slice(open + 1, close);
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

function parseEntry(entry, arrays) {
  const clean = stripComments(entry);
  const hasRegions = clean.includes("Regions:");
  const stop = firstIndexOf(clean, hasRegions ? ["Regions:"] : ARRAY_STOP);
  const p = parseScalars(stop < 0 ? clean : clean.slice(0, stop), {});

  // Regions
  let regionEnd = -1;
  if (hasRegions) {
    const ri = clean.indexOf("Regions:");
    const after = clean.slice(ri + "Regions:".length);
    const callMatch = /^\s*([A-Za-z_]\w*)\(/.exec(after);
    if (callMatch && ["bedrockRegions", "mantleRegions", "qwenCloudRegions"].includes(callMatch[1])) {
      const open = after.indexOf("(");
      const close = matchParen(after, open);
      p.regions = regionsForCall({ call: callMatch[1], args: readArgs(after.slice(open + 1, close)) });
      regionEnd = ri + "Regions:".length + close + 1;
    } else {
      const open = after.indexOf("{");
      if (open >= 0) {
        const close = matchBrace(after, open);
        p.regions = topLevelBraces(after.slice(open + 1, close)).map((r) => {
          const rc = stripComments(r);
          const rs = firstIndexOf(rc, ARRAY_STOP);
          const region = parseScalars(rs < 0 ? rc : rc.slice(0, rs), {});
          const mi = rc.indexOf("Models:");
          if (mi >= 0) region.models = modelsFrom(rc.slice(mi), arrays);
          return region;
        });
        regionEnd = ri + "Regions:".length + close + 1;
      }
    }
  }

  // top-level Models, after the Regions block when there is one
  const mi = clean.indexOf("Models:", regionEnd >= 0 ? regionEnd : 0);
  if (mi >= 0) p.models = modelsFrom(clean.slice(mi), arrays);

  const hi = clean.indexOf("HeaderHints:");
  if (hi >= 0) p.headerHints = parseStringList(clean.slice(hi));

  return p;
}

function modelsFrom(text, arrays) {
  const m = /Models:\s*([A-Za-z_]\w*)/.exec(text);
  if (m) return arrays[m[1]] ? arrays[m[1]].slice() : [];
  return parseStringList(text);
}

// ---------------------------------------------------------------- main

function parsePresetsGo(source) {
  const arrays = {};
  for (const name of ["arkPlanModels", "alibabaPlanModels"]) {
    const re = new RegExp(`var ${name} = \\[\\]string\\{`);
    const m = re.exec(source);
    if (m) arrays[name] = parseStringList(source.slice(m.index + m[0].length - 1));
  }

  const start = source.indexOf("var presets = []PresetDef{");
  const end = source.indexOf("\n}\n", start);
  const block = source.slice(start + "var presets = []PresetDef{".length, end);
  const parts = block.split(/\n\t\{/).filter((s) => /(^|[\s,{])ID:\s*/.test(s));
  return parts.map((part) => parseEntry(part, arrays)).filter((p) => p.id);
}

async function fetchPartners() {
  try {
    const res = await fetch("https://usemagpie.ai/api/partners", {
      signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "agent-session-recap" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return (data.partners || []).map((p) => {
      const out = {
        ...p,
        kind: "partner",
        sponsored: true,
        note: p.notes ? p.notes.zh || p.notes.en || "" : "",
      };
      // 只保留厂商自己的地址：去掉中转跳转与外部图床，图标用内置字母徽标
      out.website = vendorSite(p) || out.website;
      out.keysUrl = vendorSite(p) || "";
      delete out.iconUrl;
      // 图标用内置徽标（颜色由 id 推导），不用外部图床
      out.icon = out.icon || p.id;
      delete out.notes;
      delete out.langs;
      delete out.from;
      delete out.until;
      if (Array.isArray(out.regions)) {
        out.regions = out.regions.map((r) => {
          const rr = { ...r };
          rr.website = vendorSite(p, r) || rr.website;
          rr.keysUrl = vendorSite(p, r) || "";
          delete rr.iconUrl;
          return rr;
        });
      }
      return out;
    });
  } catch (e) {
    console.error("partners fetch failed:", e.message);
    return [];
  }
}

/** 合作伙伴自己的站点（优先用区域自带的 siteHost，否则用总站的）。 */
function vendorSite(p, region) {
  const host = (region && region.siteHost) || p.siteHost;
  return host ? "https://" + String(host).replace(/^https?:\/\//, "") : "";
}

const source = fs.readFileSync(PRESETS_GO, "utf8");
const builtins = parsePresetsGo(source);
const partners = noPartners ? [] : await fetchPartners();

const catalog = { generatedFrom: "yetone/magpie internal/provider/presets.go", presets: [...builtins, ...partners] };
const outPath = path.join(ROOT, "src", "presets.json");
fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2) + "\n");

console.log(`wrote ${outPath}: ${builtins.length} built-in presets, ${partners.length} partners`);
const byKind = {};
for (const p of catalog.presets) byKind[p.kind || "?"] = (byKind[p.kind || "?"] || 0) + 1;
console.log("by kind:", byKind);
console.log(
  "sample:",
  catalog.presets.slice(0, 3).map((p) => `${p.id}(${p.kind})${p.chat || p.anthropic || p.decide || ""}`),
);
