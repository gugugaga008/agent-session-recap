// Filesystem scan: collect *.jsonl under the sessions root and its immediate
// subdirectories (the `--cwd--` groups plus `.pideck-archive`). Read-only.
import fs from "node:fs/promises";
import path from "node:path";

/** True when a path lives inside the PiDeck archive directory. */
export function isArchived(file) {
  return path
    .resolve(file)
    .split(path.sep)
    .some((seg) => seg === ".pideck-archive");
}

async function jsonlIn(dir, seen, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith(".jsonl")) continue;
    const p = path.join(dir, e.name);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
}

/**
 * Returns absolute paths of every session file. Scans the root (files placed
 * directly there) plus one level of subdirectories, matching how pi and
 * session-insight enumerate sessions.
 */
export async function collectSessionFiles(sessionsDir) {
  const out = [];
  const seen = new Set();
  await jsonlIn(sessionsDir, seen, out);
  let top;
  try {
    top = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of top) {
    if (e.isDirectory()) await jsonlIn(path.join(sessionsDir, e.name), seen, out);
  }
  return out;
}
