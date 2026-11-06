// Time helpers. Session entry timestamps are RFC3339 UTC; user-supplied ranges
// are interpreted in the machine's LOCAL time zone. Ranges are half-open:
// [from, to). A date-only value means local midnight of that day.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Parse an RFC3339/ISO timestamp (from a session entry) into epoch ms. */
export function parseEntryTime(s) {
  if (!s || typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Parse a user-supplied local time string into epoch ms.
 * Accepts `YYYY-MM-DD`, `YYYY-MM-DD HH:mm[:ss]`, `YYYY-MM-DDTHH:mm[:ss]`,
 * or any Date-parseable string (fallback).
 */
export function parseLocalTime(input) {
  if (input == null || input === "") return null;
  const s = String(input).trim();
  let m = s.match(DATE_ONLY);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime();
  m = s.match(DATE_TIME);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0).getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Format epoch ms as local `YYYY-MM-DD HH:mm:ss`. */
export function formatLocal(ms) {
  if (ms == null) return "-";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Format epoch ms as a local ISO-ish string for inputs: `YYYY-MM-DDTHH:mm`. */
export function formatLocalInput(ms) {
  if (ms == null) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}
