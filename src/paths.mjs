// Path resolution — mirrors pi's own precedence so this tool sees exactly the
// sessions pi sees. Read-only: we only ever read settings.json here.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Agent config dir: PI_CODING_AGENT_DIR or ~/.pi/agent */
export function getAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) return path.resolve(expandTilde(envDir));
  return path.join(os.homedir(), ".pi", "agent");
}

function settingsSessionDir() {
  try {
    const p = path.join(getAgentDir(), "settings.json");
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    if (typeof j.sessionDir === "string" && j.sessionDir.trim()) {
      return path.resolve(expandTilde(j.sessionDir.trim()));
    }
  } catch {
    /* missing / unreadable / invalid -> ignore */
  }
  return null;
}

/**
 * Sessions root. Precedence (highest first):
 *   --session-dir  >  PI_CODING_AGENT_SESSION_DIR  >  settings.json:sessionDir  >  <agentDir>/sessions
 */
export function getSessionsDir(cliSessionDir) {
  if (cliSessionDir) return path.resolve(expandTilde(cliSessionDir));
  const env = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (env) return path.resolve(expandTilde(env));
  const fromSettings = settingsSessionDir();
  if (fromSettings) return fromSettings;
  return path.join(getAgentDir(), "sessions");
}

/** The user's Downloads folder. */
export function getDownloadsDir() {
  return path.join(os.homedir(), "Downloads");
}

/** Default export target = a timestamped folder nested under Downloads. */
export function getDefaultExportDir(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(
    now.getMinutes(),
  )}${p(now.getSeconds())}`;
  return path.join(getDownloadsDir(), `agent-session-recap-${ts}`);
}

/** Where this tool keeps its own cache (never inside the sessions tree). */
export function getCacheDir() {
  return path.join(os.homedir(), ".agent-session-recap");
}
