// Filtering engine: a time field × half-open [from, to) range, plus optional
// cwd glob / keyword / archived toggle. Pure and side-effect free.
import { parseLocalTime } from "./time.mjs";

export const TIME_FIELDS = ["created", "lastActivity", "lastMessage", "mtime", "activity"];
export const DEFAULT_FIELD = "lastActivity";

export function globToRegExp(glob) {
  const esc = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp("^" + esc + "$", "i");
}

/**
 * @param {Array} list  metadata cards
 * @param {object} opts { field, from, to, includeArchived, cwd, grep, sortDesc }
 *   from/to are epoch ms (inclusive from, exclusive to).
 */
export function filterSessions(list, opts = {}) {
  const field = TIME_FIELDS.includes(opts.field) ? opts.field : DEFAULT_FIELD;
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const includeArchived = !!opts.includeArchived;
  const cwdRe = opts.cwd ? globToRegExp(opts.cwd) : null;
  const grep = opts.grep ? String(opts.grep).toLowerCase() : null;

  const out = list.filter((s) => {
    if (!includeArchived && s.archived) return false;
    if (cwdRe && !cwdRe.test(s.cwd || "")) return false;
    if (field === "activity") {
      // 「区间内有活动」：只要 [from,to) 内存在任意一条记录即命中（重叠判定）。
      if (from != null || to != null) {
        const times = s.activityTimes || [];
        let hit = false;
        for (const t of times) {
          if ((from == null || t >= from) && (to == null || t < to)) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }
    } else {
      const t = s[field];
      if (from != null || to != null) {
        if (t == null) return false;
        if (from != null && t < from) return false;
        if (to != null && t >= to) return false;
      }
    }
    if (grep) {
      const hay = `${s.name} ${s.preview} ${s.cwd} ${s.id}`.toLowerCase();
      if (!hay.includes(grep)) return false;
    }
    return true;
  });

  const dir = opts.sortDesc === false ? 1 : -1;
  out.sort((a, b) => {
    const av = a[field] ?? -Infinity;
    const bv = b[field] ?? -Infinity;
    if (av !== bv) return av < bv ? dir : -dir;
    const aa = a.lastActivity ?? -Infinity;
    const ba = b.lastActivity ?? -Infinity;
    if (aa !== ba) return aa < ba ? dir : -dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

/** Resolve {from,to} from string options into epoch ms, validating order. */
export function resolveRange(fromStr, toStr) {
  const from = fromStr ? parseLocalTime(fromStr) : null;
  const to = toStr ? parseLocalTime(toStr) : null;
  if (fromStr && from == null) throw new Error(`无效的 --from 值：${fromStr}`);
  if (toStr && to == null) throw new Error(`无效的 --to 值：${toStr}`);
  if (from != null && to != null && from > to) throw new Error("--from 不能晚于 --to");
  return { from, to };
}
