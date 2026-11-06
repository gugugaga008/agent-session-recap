// 用 Chrome DevTools 协议给网页 UI 截图（零依赖）。
// 用法：node scripts/shoot.mjs <baseUrl> <outDir>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.argv[2] || "http://127.0.0.1:8651/";
const OUT = path.resolve(process.argv[3] || "docs/screenshots");
const PORT = 9333;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (url) =>
  new Promise((res, rej) => {
    http
      .get(url, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => res(JSON.parse(d)));
      })
      .on("error", rej);
  });

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else {
        for (const l of [...this.listeners]) l(m);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method) {
    return new Promise((res) => {
      const l = (m) => {
        if (m.method === method) {
          this.listeners = this.listeners.filter((x) => x !== l);
          res(m);
        }
      };
      this.listeners.push(l);
    });
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "asr-shoot-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    targets = await getJSON(`http://127.0.0.1:${PORT}/json`);
    if (targets.some((t) => t.type === "page")) break;
  } catch {
    /* retry */
  }
  await sleep(200);
}
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("找不到 Chrome page target");
  chrome.kill();
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const cdp = new CDP(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

async function shoot(name, setup) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: BASE });
  await loaded;
  await sleep(1400); // 等 fetch + 渲染
  if (setup) {
    await cdp.send("Runtime.evaluate", { expression: setup, awaitPromise: true });
    await sleep(700);
  }
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  console.log("已写出", name);
}

// 1) 总览
await shoot("overview.png");

// 2) 飞书式筛选器：加一条「活动时间（区间内有活动）」条件，并展开字段下拉
await shoot(
  "filter.png",
  `
  (async () => {
    conditions = [{ id: 1, field: "activity", op: "between", value: "2026-11-05T00:00", value2: "2026-11-06T00:00" }];
    renderConditions();
    await apply();
    document.querySelector(".cond-field").click();
  })()
  `,
);

// 3) 确认导出弹框（含目录选择）
await shoot(
  "export-confirm.png",
  `
  openConfirm(
    ["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002","00000000-0000-4000-8000-000000000003"],
    "昨天（最后活动时间：2026-11-05T00:00 ~ 2026-11-06T00:00）"
  );
  `,
);

ws.close();
chrome.kill();
await sleep(300);
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* ignore */
}
console.log("完成 →", OUT);
