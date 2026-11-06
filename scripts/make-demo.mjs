// 生成用于 README 截图的「合成」会话数据，写入 docs/demo-sessions/。
// 全部为虚构内容，不含任何真实路径 / 名称 / 会话 ID，可安全公开。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "demo-sessions");
fs.rmSync(OUT, { recursive: true, force: true });

const dir = path.join(OUT, "--C--projects-demo--");
fs.mkdirSync(dir, { recursive: true });

let seq = 0;
const hex = (n, w = 12) => n.toString(16).padStart(w, "0");
const uuid = () => `00000000-0000-4000-8000-${hex(++seq)}`;
const eid = () => "e" + hex(seq++, 6);
const iso = (d) => d.toISOString();

const MODEL = "demo-model";

/** 会话定义：name / cwd / 起始时间 / 若干轮对话 */
const SESSIONS = [
  {
    name: "重构登录模块",
    cwd: "C:\\projects\\demo-app",
    start: "2026-11-02T01:15:00Z",
    turns: [
      { user: "帮我把登录模块拆成独立的 auth 服务，别动其它代码。", assistant: "我先看一下现有的登录相关文件，再规划拆分。", tool: "read", args: { path: "src/auth/login.ts" }, result: "export function login(...) { ... }" },
      { user: "token 刷新也一起挪过去。", assistant: "好的，我把 refresh 逻辑一并迁到 auth 服务，并补一个单测。", tool: "edit", args: { path: "src/auth/login.ts" }, result: "applied 1 edit" },
    ],
  },
  {
    name: "修复分页越界 bug",
    cwd: "C:\\projects\\demo-app",
    start: "2026-11-02T06:00:00Z",
    turns: [
      { user: "列表翻到最后一页会报 500，帮我查一下。", assistant: "看到 offset 计算没有做边界保护，我加个钳制。", tool: "bash", args: { command: "npm test -- pagination" }, result: "3 passed" },
    ],
  },
  {
    name: "给 API 加限流",
    cwd: "C:\\projects\\api-server",
    start: "2026-11-03T02:00:00Z",
    turns: [
      { user: "给所有写接口加个令牌桶限流，默认每 IP 每分钟 60 次。", assistant: "我用一个内存令牌桶中间件实现，阈值可配置。", tool: "write", args: { path: "src/middleware/rateLimit.ts" }, result: "created file" },
      { user: "超限返回 429，带上 Retry-After。", assistant: "已加上 429 和 Retry-After 头。", tool: "edit", args: { path: "src/middleware/rateLimit.ts" }, result: "applied 1 edit" },
    ],
  },
  {
    name: "写部署文档",
    cwd: "D:\\work\\docs-site",
    start: "2026-11-03T07:30:00Z",
    turns: [
      { user: "整理一份从零到上线的部署文档，包含 docker 和反向代理。", assistant: "我按「准备环境 → 构建镜像 → 反向代理 → 健康检查」组织。", tool: "write", args: { path: "docs/deploy.md" }, result: "created file" },
    ],
  },
  {
    name: "排查 CI 失败",
    cwd: "C:\\projects\\api-server",
    start: "2026-11-04T01:00:00Z",
    turns: [
      { user: "CI 昨天开始一直红，帮我看看。", assistant: "是缓存 key 没带 lockfile 哈希，依赖装串了，我修一下。", tool: "bash", args: { command: "git log --oneline -5" }, result: "a1b2c3d fix cache key" },
    ],
  },
  {
    name: "整理数据库索引",
    cwd: "C:\\projects\\demo-app",
    start: "2026-11-05T02:00:00Z",
    turns: [
      { user: "订单表查询很慢，帮我看看该加哪些索引。", assistant: "主要慢在 (user_id, created_at) 的复合查询，我建议加联合索引。", tool: "bash", args: { command: "EXPLAIN ANALYZE SELECT ..." }, result: "Seq Scan on orders (cost=...)" },
      { user: "加吧，顺便写个迁移。", assistant: "已生成迁移文件，并加了回滚。", tool: "write", args: { path: "migrations/20261105_add_orders_index.sql" }, result: "created file" },
    ],
  },
  {
    name: "跨天会话：压测与调优",
    cwd: "C:\\projects\\demo-app",
    start: "2026-11-05T12:00:00Z",
    turns: [
      { user: "跑一轮压测，目标是 500 QPS 下 P99 < 200ms。", assistant: "先跑基线，再逐步定位瓶颈。", tool: "bash", args: { command: "wrk -t8 -c200 -d60s http://localhost:3000/api/items" }, result: "Requests/sec: 812.44" },
      { user: "把连接池调大再看看。", assistant: "连接池从 10 调到 40，P99 明显下降。", tool: "edit", args: { path: "src/db/pool.ts" }, result: "applied 1 edit" },
    ],
  },
  {
    name: "性能压测报告",
    cwd: "D:\\work\\docs-site",
    start: "2026-11-06T01:30:00Z",
    turns: [
      { user: "把昨天的压测结果写成一份报告。", assistant: "我按「目标 → 方法 → 结果 → 结论」整理，附上关键图表。", tool: "write", args: { path: "docs/perf-report.md" }, result: "created file" },
    ],
  },
];

function build(s) {
  const lines = [];
  let t = new Date(s.start);
  const id = uuid();
  let parent = null;
  const emit = (o) => lines.push(JSON.stringify(o));

  emit({ type: "session", version: 3, id, timestamp: iso(t), cwd: s.cwd });
  let m = eid();
  emit({ type: "model_change", id: m, parentId: null, timestamp: iso(t), provider: "demo", modelId: MODEL });
  parent = m;
  m = eid();
  emit({ type: "thinking_level_change", id: m, parentId: parent, timestamp: iso(t), thinkingLevel: "high" });
  parent = m;

  for (const turn of s.turns) {
    t = new Date(t.getTime() + 90_000);
    let e = eid();
    emit({ type: "message", id: e, parentId: parent, timestamp: iso(t), message: { role: "user", content: [{ type: "text", text: turn.user }] } });
    parent = e;

    t = new Date(t.getTime() + 20_000);
    e = eid();
    const callId = "call_" + hex(seq++, 8);
    emit({
      type: "message",
      id: e,
      parentId: parent,
      timestamp: iso(t),
      message: {
        role: "assistant",
        model: MODEL,
        provider: "demo",
        durationMs: 4200,
        stopReason: "toolUse",
        usage: { input: 820, output: 210, totalTokens: 1030, cost: { total: 0.0012 } },
        content: [
          { type: "thinking", thinking: "先读取相关文件确认现状，再做最小改动。", thinkingSignature: "[{\"type\":\"reasoning.text\"}]" },
          { type: "text", text: turn.assistant },
          { type: "toolCall", id: callId, name: turn.tool, arguments: turn.args },
        ],
      },
    });
    parent = e;

    t = new Date(t.getTime() + 3_000);
    e = eid();
    emit({
      type: "message",
      id: e,
      parentId: parent,
      timestamp: iso(t),
      message: { role: "toolResult", toolCallId: callId, toolName: turn.tool, isError: false, durationMs: 120, content: [{ type: "text", text: turn.result }] },
    });
    parent = e;

    t = new Date(t.getTime() + 15_000);
    e = eid();
    emit({
      type: "message",
      id: e,
      parentId: parent,
      timestamp: iso(t),
      message: {
        role: "assistant",
        model: MODEL,
        provider: "demo",
        durationMs: 2600,
        stopReason: "stop",
        usage: { input: 240, output: 130, totalTokens: 370, cost: { total: 0.0005 } },
        content: [{ type: "text", text: "已完成这一步，继续下一项。" }],
      },
    });
    parent = e;
  }

  emit({ type: "session_info", id: eid(), parentId: parent, timestamp: iso(t), name: s.name });
  return lines.join("\n") + "\n";
}

let count = 0;
for (const s of SESSIONS) {
  const id = s._id || (s._id = uuid());
  const stamp = s.start.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}_${id}.jsonl`);
  fs.writeFileSync(file, build(s), "utf8");
  count++;
}
console.log(`已生成 ${count} 个合成会话 → ${path.relative(ROOT, dir)}`);
