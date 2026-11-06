"use strict";

const $ = (id) => document.getElementById(id);

let allSessions = []; // 服务端返回的全部会话
let sessions = []; // 当前筛选后的会话
let scannedCount = 0; // 本次扫描到的会话总数
let conditions = []; // 筛选条件
let condSeq = 1;
let sortKey = null;
let sortDir = "asc";
let pendingExport = null;

// ---- 字段与操作符定义 ----
const FIELDS = [
  { key: "lastActivity", label: "最后活动时间", type: "date", icon: "🕐" },
  { key: "lastMessage", label: "最后一条消息时间", type: "date", icon: "🕐" },
  { key: "created", label: "创建时间", type: "date", icon: "🕐" },
  { key: "mtime", label: "文件更新时间", type: "date", icon: "🕐" },
  { key: "activity", label: "活动时间（区间内有活动）", type: "daterange", icon: "⟷" },
  { key: "cwd", label: "工作目录", type: "text", icon: "A" },
  { key: "displayName", label: "会话名称", type: "text", icon: "A" },
  { key: "id", label: "会话 ID", type: "text", icon: "A" },
  { key: "size", label: "大小", type: "number", icon: "#" },
  { key: "archived", label: "归档", type: "boolean", icon: "☑" },
];
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

const OPS = {
  date: [
    ["between", "在...之间"],
    ["before", "早于"],
    ["after", "晚于"],
    ["empty", "为空"],
    ["notEmpty", "不为空"],
  ],
  text: [
    ["contains", "包含"],
    ["notContains", "不包含"],
    ["eq", "等于"],
    ["neq", "不等于"],
    ["startsWith", "开头是"],
    ["endsWith", "结尾是"],
    ["empty", "为空"],
    ["notEmpty", "不为空"],
  ],
  number: [
    ["eq", "等于"],
    ["neq", "不等于"],
    ["gt", "大于"],
    ["lt", "小于"],
    ["gte", "大于等于"],
    ["lte", "小于等于"],
  ],
  boolean: [["eq", "等于"]],
  daterange: [["between", "在...之间"]],
};

// ---- 工具 ----
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmtTime(ms) {
  if (ms == null) return "-";
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtSize(bytes) {
  if (bytes == null) return "-";
  const kb = bytes / 1024;
  return kb < 1024 ? kb.toFixed(1) + "K" : (kb / 1024).toFixed(1) + "M";
}
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function parseLocalInput(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}
function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

// ---- 自定义下拉（带搜索、类型图标） ----
let activeDD = null;
function closeDropdown() {
  if (activeDD) {
    activeDD.remove();
    activeDD = null;
    document.removeEventListener("mousedown", onDocDown, true);
  }
}
function onDocDown(e) {
  if (!activeDD) return;
  if (activeDD.contains(e.target)) return;
  if (activeDD._anchor && activeDD._anchor.contains(e.target)) return;
  closeDropdown();
}
function openDropdown(anchor, { items, current, search, placeholder, onPick }) {
  closeDropdown();
  const dd = document.createElement("div");
  dd.className = "dd";
  dd._anchor = anchor;
  const rect = anchor.getBoundingClientRect();
  dd.style.left = rect.left + "px";
  dd.style.top = rect.bottom + 4 + "px";
  dd.style.minWidth = Math.max(rect.width, 220) + "px";

  let list = dd;
  let searchInput = null;
  if (search) {
    searchInput = document.createElement("input");
    searchInput.className = "dd-search";
    searchInput.placeholder = placeholder || "搜索字段";
    dd.appendChild(searchInput);
    list = document.createElement("div");
    list.className = "dd-list";
    dd.appendChild(list);
  }
  const renderItems = (filter) => {
    list.innerHTML = "";
    for (const it of items) {
      if (filter && !it.label.toLowerCase().includes(filter.toLowerCase())) continue;
      const row = document.createElement("div");
      row.className = "dd-item" + (it.value === current ? " active" : "");
      row.innerHTML =
        (it.icon ? `<span class="fico fico-${it.type || "text"}">${it.icon}</span>` : "") +
        `<span class="dd-label">${esc(it.label)}</span>` +
        (it.value === current ? '<span class="dd-check">✓</span>' : "");
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onPick(it.value);
        closeDropdown();
      });
      list.appendChild(row);
    }
    if (!list.children.length) {
      const empty = document.createElement("div");
      empty.className = "dd-empty";
      empty.textContent = "无匹配项";
      list.appendChild(empty);
    }
  };
  renderItems("");
  if (searchInput) {
    searchInput.addEventListener("input", () => renderItems(searchInput.value));
    setTimeout(() => searchInput.focus(), 0);
  }
  document.body.appendChild(dd);
  activeDD = dd;
  setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
}

// ---- 条件渲染 ----
function mkInput(type, value, onChange, placeholder) {
  const i = document.createElement("input");
  i.type = type;
  if (value) i.value = value;
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

function valueWidget(c, f) {
  const wrap = document.createElement("div");
  wrap.className = "cond-val";
  if (c.op === "empty" || c.op === "notEmpty") {
    wrap.classList.add("muted");
    wrap.textContent = "—";
    return wrap;
  }
  if (f.type === "date" || f.type === "daterange") {
    if (c.op === "between") {
      const a = mkInput("datetime-local", c.value, (v) => (c.value = v));
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "至";
      const b = mkInput("datetime-local", c.value2, (v) => (c.value2 = v));
      wrap.append(a, sep, b);
    } else {
      wrap.append(mkInput("datetime-local", c.value, (v) => (c.value = v)));
    }
  } else if (f.type === "text") {
    wrap.append(mkInput("text", c.value, (v) => (c.value = v), "输入内容"));
  } else if (f.type === "number") {
    wrap.append(mkInput("number", c.value, (v) => (c.value = v), "数值"));
  } else if (f.type === "boolean") {
    const sel = document.createElement("select");
    for (const [v, l] of [["yes", "是"], ["no", "否"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      sel.appendChild(o);
    }
    if (!c.value) c.value = "yes";
    sel.value = c.value;
    sel.addEventListener("change", () => (c.value = sel.value));
    wrap.append(sel);
  }
  return wrap;
}

function conditionRow(c) {
  const row = document.createElement("div");
  row.className = "cond";
  const f = FIELD_BY_KEY[c.field];

  const fbtn = document.createElement("button");
  fbtn.type = "button";
  fbtn.className = "cond-field";
  fbtn.innerHTML = `<span class="fico fico-${f.type}">${f.icon}</span><span class="cond-text">${esc(f.label)}</span><span class="caret">▾</span>`;
  fbtn.addEventListener("click", () =>
    openDropdown(fbtn, {
      items: FIELDS.map((x) => ({ value: x.key, label: x.label, type: x.type, icon: x.icon })),
      current: c.field,
      search: true,
      onPick: (key) => {
        c.field = key;
        c.op = OPS[FIELD_BY_KEY[key].type][0][0];
        c.value = "";
        c.value2 = "";
        renderConditions();
      },
    }),
  );

  const obtn = document.createElement("button");
  obtn.type = "button";
  obtn.className = "cond-op";
  const ops = OPS[f.type];
  const opLabel = (ops.find((o) => o[0] === c.op) || ops[0])[1];
  obtn.innerHTML = `<span class="cond-text">${esc(opLabel)}</span><span class="caret">▾</span>`;
  obtn.addEventListener("click", () =>
    openDropdown(obtn, {
      items: ops.map((o) => ({ value: o[0], label: o[1] })),
      current: c.op,
      onPick: (op) => {
        c.op = op;
        c.value = "";
        c.value2 = "";
        renderConditions();
      },
    }),
  );

  const del = document.createElement("button");
  del.type = "button";
  del.className = "cond-del";
  del.textContent = "×";
  del.title = "删除条件";
  del.addEventListener("click", () => {
    conditions = conditions.filter((x) => x.id !== c.id);
    renderConditions();
  });

  row.append(fbtn, obtn, valueWidget(c, f), del);
  return row;
}

function renderConditions() {
  const box = $("conditions");
  box.innerHTML = "";
  if (!conditions.length) {
    const hint = document.createElement("div");
    hint.className = "cond-empty";
    hint.textContent = "暂无筛选条件，点击「＋ 添加条件」开始。";
    box.appendChild(hint);
    return;
  }
  for (const c of conditions) box.appendChild(conditionRow(c));
}

function addCondition() {
  conditions.push({ id: condSeq++, field: "lastActivity", op: "between", value: "", value2: "" });
  renderConditions();
}

// ---- 条件求值 ----
function condActive(c) {
  if (c.op === "empty" || c.op === "notEmpty") return true;
  if (c.field === "archived") return true;
  if (c.op === "between") return !!(c.value && c.value2);
  return !!c.value;
}

function evalCond(s, c) {
  const f = FIELD_BY_KEY[c.field];
  const v = s[c.field];
  const op = c.op;
  if (op === "empty") return v == null || v === "";
  if (op === "notEmpty") return !(v == null || v === "");
  if (f.type === "daterange") {
    const a = parseLocalInput(c.value);
    const b = parseLocalInput(c.value2);
    if (a == null || b == null) return false;
    const times = s.activityTimes || [];
    return times.some((t) => t >= a && t < b);
  }
  if (f.type === "date") {
    if (op === "between") {
      const a = parseLocalInput(c.value);
      const b = parseLocalInput(c.value2);
      return a != null && b != null && v != null && v >= a && v < b;
    }
    if (op === "before") {
      const a = parseLocalInput(c.value);
      return a != null && v != null && v < a;
    }
    if (op === "after") {
      const a = parseLocalInput(c.value);
      return a != null && v != null && v >= a;
    }
  }
  if (f.type === "text") {
    const hay = String(v || "").toLowerCase();
    const needle = String(c.value || "").toLowerCase();
    switch (op) {
      case "contains":
        return hay.includes(needle);
      case "notContains":
        return !hay.includes(needle);
      case "eq":
        return hay === needle;
      case "neq":
        return hay !== needle;
      case "startsWith":
        return hay.startsWith(needle);
      case "endsWith":
        return hay.endsWith(needle);
    }
  }
  if (f.type === "number") {
    const n = Number(v);
    const x = Number(c.value);
    switch (op) {
      case "eq":
        return n === x;
      case "neq":
        return n !== x;
      case "gt":
        return n > x;
      case "lt":
        return n < x;
      case "gte":
        return n >= x;
      case "lte":
        return n <= x;
    }
  }
  if (f.type === "boolean") {
    const want = c.value !== "no";
    return !!v === want;
  }
  return true;
}

function applyConditions(list) {
  const active = conditions.filter(condActive);
  if (!active.length) return list;
  const logic = $("logic").value;
  return list.filter((s) => {
    const res = active.map((c) => evalCond(s, c));
    return logic === "or" ? res.some(Boolean) : res.every(Boolean);
  });
}

// ---- 列宽 ----
// 列宽默认值：合计 ~1406px，在 1440 宽的屏幕上不用横向滚动
const DEFAULT_COLS = [40, 250, 210, 110, 150, 150, 150, 150, 76, 56, 64];
const STORAGE_KEY = "agent-session-recap-col-widths";
let colWidths = DEFAULT_COLS.slice();

function loadWidths() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const w = JSON.parse(raw);
      if (Array.isArray(w) && w.length === DEFAULT_COLS.length) return w;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_COLS.slice();
}
function applyWidths() {
  const cols = $("cols").children;
  for (let i = 0; i < cols.length; i++) cols[i].style.width = colWidths[i] + "px";
  $("table").style.width = colWidths.reduce((a, b) => a + b, 0) + "px";
}
function initColumns() {
  const group = $("cols");
  for (let i = 0; i < DEFAULT_COLS.length; i++) group.appendChild(document.createElement("col"));
  colWidths = loadWidths();
  applyWidths();
  document.querySelectorAll("#table thead th").forEach((th, i) => {
    if (th.dataset.key) {
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      th.appendChild(arrow);
      th.classList.add("sortable");
      th.addEventListener("click", (e) => {
        if (e.target.classList.contains("resizer")) return;
        const key = th.dataset.key;
        if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
        else {
          sortKey = key;
          sortDir = "asc";
        }
        updateArrows();
        renderRows();
      });
    }
    const handle = document.createElement("div");
    handle.className = "resizer";
    th.appendChild(handle);
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = colWidths[i];
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        colWidths[i] = Math.max(40, Math.round(startW + (ev.clientX - startX)));
        applyWidths();
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(colWidths));
        } catch {
          /* ignore */
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  });
}
function updateArrows() {
  document.querySelectorAll("#table thead th[data-key]").forEach((th) => {
    const arrow = th.querySelector(".arrow");
    if (arrow) arrow.textContent = th.dataset.key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  });
}

// ---- 排序 ----
function cmp(a, b, key) {
  let av = a[key];
  let bv = b[key];
  if (key === "archived") {
    av = av ? 1 : 0;
    bv = bv ? 1 : 0;
  }
  if (typeof av === "string" || typeof bv === "string") {
    av = String(av || "").toLowerCase();
    bv = String(bv || "").toLowerCase();
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  const an = av == null ? -Infinity : av;
  const bn = bv == null ? -Infinity : bv;
  return an < bn ? -1 : an > bn ? 1 : 0;
}
function sortedSessions() {
  if (!sortKey) return sessions;
  const arr = sessions.slice();
  arr.sort((a, b) => cmp(a, b, sortKey) * (sortDir === "asc" ? 1 : -1));
  return arr;
}

// ---- 数据 ----
async function loadConfig() {
  const cfg = await (await fetch("/api/config")).json();
  $("sessionsDir").textContent = "会话目录：" + cfg.sessionsDir;
  $("outDir").value = cfg.defaultOutDir;
}
async function fetchAll() {
  const res = await fetch("/api/sessions?includeArchived=1");
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  allSessions = data.sessions || [];
  return data;
}
async function apply() {
  setStatus("正在扫描…");
  try {
    const data = await fetchAll();
    scannedCount = data.scanned;
    sessions = applyConditions(allSessions);
    renderRows();
    renderStats();
    setStatus(`已扫描 ${data.scanned} 个会话 · 匹配 ${sessions.length} 个`);
  } catch (e) {
    setStatus("错误：" + e.message, "err");
  }
}

/** 工具栏左侧的计数：已扫描 / 匹配 / 已选 */
function renderStats() {
  const picked = document.querySelectorAll("#rows .rowpick:checked").length;
  const parts = [`已扫描 ${scannedCount} 个会话`, `匹配 ${sessions.length} 个`];
  if (picked) parts.push(`已选 ${picked} 个`);
  $("stats").textContent = parts.join(" · ");
}
function renderRows() {
  const tbody = $("rows");
  tbody.innerHTML = "";
  for (const s of sortedSessions()) {
    const name = s.displayName || s.name || s.preview || "-";
    const tr = document.createElement("tr");
    tr.dataset.id = s.id;
    tr.innerHTML = `
      <td class="pick"><input type="checkbox" class="rowpick"></td>
      <td class="cwd" title="${esc(s.cwd)}">${esc(s.cwd || "-")}</td>
      <td class="name" title="${esc(name)}">${esc(name)}</td>
      <td title="${esc(s.id)}">${esc((s.id || "").slice(0, 12))}</td>
      <td>${fmtTime(s.created)}</td>
      <td>${fmtTime(s.lastMessage)}</td>
      <td>${fmtTime(s.lastActivity)}</td>
      <td>${fmtTime(s.mtime)}</td>
      <td class="num">${fmtSize(s.size)}</td>
      <td class="${s.archived ? "arch-yes" : ""}">${s.archived ? "是" : ""}</td>
      <td class="ai-col"><button class="row-ai" title="用 AI 总结这条会话">总结</button></td>`;
    tbody.appendChild(tr);
    tr.querySelector(".row-ai").addEventListener("click", () => aiSummarizeSingle(s));
  }
  $("headPick").checked = false;
  renderStats();
}
function selectedIds() {
  return [...document.querySelectorAll("#rows tr")]
    .filter((tr) => tr.querySelector(".rowpick").checked)
    .map((tr) => tr.dataset.id);
}

// ---- 导出（含确认框 + 目录选择） ----
async function pickDirInto(inputEl) {
  setStatus("请在弹出窗口中选择目录…");
  try {
    const res = await fetch("/api/pick-dir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initial: inputEl.value || "" }),
    });
    const data = await res.json();
    if (data.path) {
      inputEl.value = data.path;
      setStatus("");
    } else {
      setStatus("未选择目录（已取消）。");
    }
  } catch (e) {
    setStatus("选择目录失败：" + e.message, "err");
  }
}

function openConfirm(ids, desc) {
  pendingExport = ids;
  const fmt = $("format").value;
  $("modalSummary").innerHTML =
    `将导出 <b>${ids.length}</b> 个会话，格式 <b>${esc(fmt)}</b>。` +
    (desc ? `<br><span class="muted">条件：${esc(desc)}</span>` : "");
  $("modalOutDir").value = $("outDir").value;
  $("modal").classList.remove("hidden");
}
function closeConfirm() {
  $("modal").classList.add("hidden");
  pendingExport = null;
}

async function exportIds(ids) {
  const outDir = $("outDir").value.trim();
  if (!outDir) return setStatus("导出目录不能为空。", "err");
  const format = $("format").value;
  setStatus(`正在导出 ${ids.length} 个会话（格式 ${format}）…`);
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, format, outDir }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    let msg = `已导出 ${data.count} 个文件到 ${data.out}`;
    if (data.failures && data.failures.length)
      msg += `\n失败 ${data.failures.length} 个：\n` + data.failures.map((f) => "  " + f.src + " — " + f.error).join("\n");
    setStatus(msg, "ok");
  } catch (e) {
    setStatus("导出失败：" + e.message, "err");
  }
}

// ---- 快捷导出时间段 ----
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfWeek(d) {
  const s = startOfDay(d);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function quickRange(kind) {
  const now = new Date();
  switch (kind) {
    case "yesterday": {
      const e = startOfDay(now);
      const s = new Date(e);
      s.setDate(s.getDate() - 1);
      return [s, e];
    }
    case "today":
      return [startOfDay(now), now];
    case "thisWeek": {
      const s = startOfWeek(now);
      const e = new Date(s);
      e.setDate(e.getDate() + 7);
      return [s, e];
    }
    case "lastWeek": {
      const e = startOfWeek(now);
      const s = new Date(e);
      s.setDate(s.getDate() - 7);
      return [s, e];
    }
    case "thisMonth": {
      const s = startOfMonth(now);
      const e = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return [s, e];
    }
    case "lastMonth": {
      const e = startOfMonth(now);
      const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return [s, e];
    }
    default:
      return [startOfDay(now), now];
  }
}
const QUICK_LABEL = {
  yesterday: "昨天",
  today: "今天",
  thisWeek: "这周",
  lastWeek: "上周",
  thisMonth: "这个月",
  lastMonth: "上个月",
};

async function quickExport(kind) {
  const [from, to] = quickRange(kind);
  const field = $("quickField").value;
  conditions = [
    { id: condSeq++, field, op: "between", value: toLocalInput(from), value2: toLocalInput(to) },
  ];
  renderConditions();
  await apply();
  if (!sessions.length) {
    setStatus(`「${QUICK_LABEL[kind]}」时间段没有匹配的会话。`, "err");
    return;
  }
  const fieldLabel = FIELD_BY_KEY[field].label;
  openConfirm(
    sessions.map((s) => s.id),
    `${QUICK_LABEL[kind]}（${fieldLabel}：${toLocalInput(from)} ~ ${toLocalInput(to)}）`,
  );
}

// ---- 事件绑定 ----
$("addCond").addEventListener("click", addCondition);
$("clearCond").addEventListener("click", () => {
  conditions = [];
  renderConditions();
});
$("apply").addEventListener("click", apply);
$("logic").addEventListener("change", apply);
$("selectAll").addEventListener("click", () => {
  document.querySelectorAll(".rowpick").forEach((c) => (c.checked = true));
  renderStats();
});
$("selectNone").addEventListener("click", () => {
  document.querySelectorAll(".rowpick").forEach((c) => (c.checked = false));
  $("headPick").checked = false;
  renderStats();
});
$("headPick").addEventListener("change", (e) => {
  document.querySelectorAll(".rowpick").forEach((c) => (c.checked = e.target.checked));
  renderStats();
});
$("rows").addEventListener("change", (e) => {
  if (e.target.classList.contains("rowpick")) renderStats();
});
$("pickDir").addEventListener("click", () => pickDirInto($("outDir")));
$("export").addEventListener("click", () => {
  const ids = selectedIds();
  if (!ids.length) return setStatus("请先至少选择一个会话。", "err");
  openConfirm(ids, "已选中的会话");
});
$("modalPickDir").addEventListener("click", () => pickDirInto($("modalOutDir")));
$("modalCancel").addEventListener("click", closeConfirm);
$("modal").addEventListener("click", (e) => {
  if (e.target === $("modal")) closeConfirm();
});
$("modalConfirm").addEventListener("click", async () => {
  const ids = pendingExport || [];
  $("outDir").value = $("modalOutDir").value.trim();
  closeConfirm();
  if (ids.length) await exportIds(ids);
});
document.querySelectorAll(".quick button[data-quick]").forEach((b) => {
  b.addEventListener("click", () => quickExport(b.dataset.quick));
});

initColumns();
renderConditions();
loadConfig().then(() => {
  apply();
  initAi();
});
