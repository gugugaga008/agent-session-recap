// 用 Chrome DevTools 协议给网页 UI 截图（零依赖）。
//
// 默认自包含：自己生成演示会话、用一个临时配置目录（含合成供应商）起服务、截完图再关掉。
//
//   node scripts/shoot.mjs                 # 全部重截，写到 docs/screenshots
//   node scripts/shoot.mjs --reuse         # 复用已启动的 http://127.0.0.1:8651
//   node scripts/shoot.mjs --out <目录>    # 指定输出目录
//
// 截图里的一切（会话、路径、供应商、密钥、AI 输出）都是合成的，可安全公开。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = path.resolve(opt("--out", path.join(ROOT, "docs", "screenshots")));
const WEB_PORT = Number(opt("--port", 8765));
const REUSE = flag("--reuse");
const BASE = REUSE ? opt("--base", "http://127.0.0.1:8651") + "/" : `http://127.0.0.1:${WEB_PORT}/`;
const CDP_PORT = 9333;
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

// ---------------------------------------------------------------- 演示数据

const DEMO_SESSIONS = path.join(ROOT, "docs", "demo-sessions");

function ensureDemoSessions() {
  const ok = fs.existsSync(DEMO_SESSIONS) && fs.readdirSync(DEMO_SESSIONS).length > 0;
  if (ok) return;
  console.log("生成演示会话…");
  spawn(process.execPath, [path.join(ROOT, "scripts", "make-demo.mjs")], { stdio: "inherit", cwd: ROOT });
}

/** 合成供应商：域名与密钥都是假的，只是为了让界面能截图。 */
function writeDemoProviders(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  const data = {
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        icon: "deepseek-color",
        preset: "deepseek",
        key: "sk-demo-0000000000000000000000000000",
        chat: "https://api.deepseek.com/v1",
        responses: "https://api.deepseek.com/v1",
        anthropic: "https://api.deepseek.com/anthropic",
        models: ["deepseek-chat"],
        pickedFrom: ["deepseek-chat", "deepseek-reasoner"],
        modelMeta: {
          "deepseek-chat": { context: 128000, maxOutput: 8192, reasoning: false, vision: false, source: "models.dev" },
        },
        off: false,
      },
      {
        id: "relay",
        name: "我的中转",
        icon: "generic",
        preset: null,
        key: "sk-demo-1111111111111111111111111111",
        chat: "https://relay.example.com/v1",
        anthropic: "https://relay.example.com",
        models: ["gpt-5.5", "claude-sonnet-5"],
        pickedFrom: ["gpt-5.5", "claude-sonnet-5", "gemini-3.5-flash"],
        modelMeta: {
          "gpt-5.5": { context: 400000, maxOutput: 128000, reasoning: true, vision: true, source: "upstream" },
          "claude-sonnet-5": { context: 1000000, maxOutput: 64000, reasoning: true, vision: true, source: "models.dev" },
        },
        off: true,
      },
    ],
    prefs: { defaultProvider: "deepseek", defaultModel: "deepseek-chat" },
  };
  fs.writeFileSync(path.join(configDir, "providers.json"), JSON.stringify(data, null, 2));
}

/** 截图用的合成 AI 总结文本。 */
const DEMO_SUMMARY = `## 一句话概括
把登录相关代码从单体应用里拆成独立的 auth 服务，token 刷新逻辑一并迁移，并补上单元测试。

## 背景与目标
- 目标：登录、token 刷新从 \`src/auth\` 解耦，其它模块不改动
- 约束：不能影响现有调用方

## 主要工作
- 读取 \`src/auth/login.ts\`，梳理登录与刷新两条链路
- 把 refresh 逻辑迁到 \`src/auth/refresh.ts\`
- 新增 \`src/auth/login.test.ts\`，覆盖过期与并发刷新两种场景
- 跑 \`npm test -- auth\`，3 个用例全部通过

## 关键决策与原因
- **不引入新的服务进程**：先用同进程内的模块边界拆分，降低上线风险
- **保留原有导出签名**：调用方零改动

## 遇到的问题与解决
- 并发刷新会重复写入 token → 加了一次去重的 single-flight 保护

## 最终结果 / 产出
- \`src/auth/login.ts\`、\`src/auth/refresh.ts\`、\`src/auth/login.test.ts\`

## 未完成与后续建议
- 还没有做跨服务的会话校验，建议下一步补上 token 的集中吊销`;

// ---------------------------------------------------------------- 服务

let server = null;
let configDir = null;

async function startServer() {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "asr-shoot-cfg-"));
  writeDemoProviders(configDir);
  server = spawn(
    process.execPath,
    [
      path.join(ROOT, "bin", "agent-session-recap.mjs"),
      "web",
      "--port",
      String(WEB_PORT),
      "--session-dir",
      DEMO_SESSIONS,
    ],
    { cwd: ROOT, stdio: "ignore", env: { ...process.env, ASR_CONFIG_DIR: configDir } },
  );
  for (let i = 0; i < 60; i++) {
    try {
      await getJSON(`http://127.0.0.1:${WEB_PORT}/api/config`);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("网页服务没有起来（端口 " + WEB_PORT + "）");
}

// ---------------------------------------------------------------- Chrome

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

// ---------------------------------------------------------------- main

ensureDemoSessions();
if (!REUSE) {
  await startServer();
  console.log("服务已启动：" + BASE);
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
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let targets = [];
for (let i = 0; i < 60; i++) {
  try {
    targets = await getJSON(`http://127.0.0.1:${CDP_PORT}/json`);
    if (targets.some((t) => t.type === "page")) break;
  } catch {
    /* retry */
  }
  await sleep(200);
}
const pageTarget = targets.find((t) => t.type === "page");
if (!pageTarget) {
  console.error("找不到 Chrome page target");
  chrome.kill();
  process.exit(1);
}
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const cdp = new CDP(ws);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});

async function shoot(name, setup) {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: BASE });
  await loaded;
  await sleep(1600); // 等 fetch + 渲染
  if (setup) {
    const r = await cdp.send("Runtime.evaluate", { expression: setup, awaitPromise: true });
    if (r.exceptionDetails) console.warn("  脚本报错:", r.exceptionDetails.text);
    await sleep(800);
  }
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  console.log("已写出", name);
}

// 1) 总览：表格 + AI 工具条
await shoot("overview.png");

// 2) 条件构建器：加一条「活动时间（区间内有活动）」条件，并展开字段下拉
//    （不点「应用筛选」，这样表格仍保留全部会话，截图不会留下大片空白）
await shoot(
  "filter.png",
  `
  (async () => {
    conditions = [{ id: 1, field: "activity", op: "between", value: "2026-11-05T00:00", value2: "2026-11-06T00:00" }];
    renderConditions();
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

// 4) 添加供应商：预设卡片列表
await shoot(
  "providers.png",
  `
  (async () => {
    openAddProvider();
  })()
  `,
);

// 5) AI 总结面板（内容为合成文本，不联网）
await shoot(
  "ai-summary.png",
  `
  (async () => {
    openAiPanel("single", "AI 总结", "重构登录模块");
    ai.raw = ${JSON.stringify(DEMO_SUMMARY)};
    ai.progress = "已完成 · 供应商 DeepSeek · 模型 deepseek-chat";
    renderAiProgress();
    renderAiOutput();
    setAiStatus("完成");
  })()
  `,
);

ws.close();
chrome.kill();
if (server) server.kill();
await sleep(400);
for (const dir of [profile, configDir]) {
  if (!dir) continue;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
console.log("完成 →", OUT);
