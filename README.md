# pi-sessions

一个用于浏览、按时间段筛选、导出 [pi](https://pi.dev) 会话的 **只读** 工具。

它扫描 pi 使用的同一套会话目录，可按选定的时间字段、在 `起始 → 结束` 时间区间内筛选会话，
记录筛选结果，并把选中的会话导出为 JSONL、Markdown 或 HTML。**源会话永不被修改**——导出只是复制出去。

零依赖、无构建步骤，需要 Node.js 18+。

## 快速开始

```bash
# 列出全部会话
node bin/pi-sessions.mjs list

# 按「最后活动时间」筛选本地时间段
node bin/pi-sessions.mjs list --field lastActivity --from 2026-11-05 --to 2026-11-06

# 启动网页界面（http://127.0.0.1:8651）
node bin/pi-sessions.mjs web
```

## 会话目录来源

工具解析会话根目录的方式与 pi 完全一致，优先级从高到低：

1. `--session-dir <目录>`
2. 环境变量 `PI_CODING_AGENT_SESSION_DIR`
3. `<agentDir>/settings.json` 里的 `sessionDir`
4. `<agentDir>/sessions`（默认），其中 `<agentDir>` 为 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`

扫描范围为根目录 + 一层子目录：即各个 `--cwd--` 分组目录，以及 PiDeck 的 `.pideck-archive`。

## 时间字段

每个会话暴露四个可选时间字段（表格中全部展示）：

| 字段 | 含义 |
|---|---|
| `created` | 会话创建时间（文件头 timestamp） |
| `lastActivity` | **任意类型最后一条记录**的时间（默认） |
| `lastMessage` | **最后一条消息**的时间 |
| `mtime` | 文件系统**最后修改**时间 |

会话记录里的时间戳以 UTC 存储；你传入的时间区间按**本地时区**解释。区间为**半开区间** `[from, to)`。
只给日期时按本地 0 点处理，因此 `--from 2026-11-05 --to 2026-11-06` 正好选中 11 月 5 日这一整天。

## 命令

### `list`

```bash
node bin/pi-sessions.mjs list [筛选] [--json|--csv] [--save <文件>] [--limit <n>]
```

输出表格（或 JSON/CSV）。`--save <文件>` 会把筛选结果写入 JSON，供 `export --result` 使用。

### `web`

```bash
node bin/pi-sessions.mjs web [--port 8651] [--host 127.0.0.1] [--open]
```

提供一个轻量单页界面 + 少量 JSON 接口，默认只绑定 `127.0.0.1`。页面里可以设置筛选、勾选行、
选择导出格式与输出目录（预填「下载」下带时间戳的子文件夹），然后导出。

- **飞书式筛选器**：点「＋ 添加条件」，每条条件为 `字段 ▾ 条件 ▾ 值`，字段下拉带搜索与类型图标；
  条件之间可选「满足全部（且）」或「满足任一（或）」。支持字段：活动时间（区间内有活动）/ 最后活动时间 /
  最后一条消息时间 / 创建时间 / 文件更新时间 / 工作目录 / 会话名称 / 会话 ID / 大小 / 归档。筛选在浏览器本地完成。
  「活动时间（区间内有活动）」用于跨天会话：只要会话在 `[起始, 结束)` 内有**任意一条记录**即命中，
  不会因为「最后活动时间/创建时间落在区间外」而遗漏。
- **表头点击排序**：点任意列标题按该列升序/降序切换（再点一次反向）。
- **列宽可拖拽调整**：拖动表头右边缘改列宽，宽度记住在浏览器本地。
- **快捷导出**：一键导出固定时间段的全部会话——昨天、今天、这周、上周、这个月、上个月
  （可选择时间依据字段，周一为一周开始）。
- **确认弹框 + 目录选择**：一键导出（及「导出所选」）会先弹确认框，显示会话数量、格式与条件，
  并可直接「选择目录…」调用本机原生文件夹选择对话框（Windows 用 PowerShell 弹出）。

接口：`GET /api/config`、`GET /api/sessions`、`POST /api/export`、`POST /api/pick-dir`（弹原生目录选择框）。

### `export`

```bash
node bin/pi-sessions.mjs export [筛选 | --result <文件>] [--ids a,b] \
    --format jsonl|md|html --out <目录>
```

- `jsonl` —— 原样复制会话文件。
- `md` —— 每轮输出 **用户** 与 **助手** 文本、**工具名称**，以及 token/耗时（不含思考过程，不含工具参数与结果）。
- `html` —— 与 Markdown 相同内容，生成独立带样式的网页。

`--out` 默认为「下载」目录下按时间戳新建的子文件夹，例如 `Downloads\pi-sessions-20261106-142530`，
避免导出文件散落在下载目录里。每次导出都会生成一份 `manifest.json` 清单。同名文件不会覆盖（自动追加数字后缀）。

## 筛选参数

| 参数 | 说明 |
|---|---|
| `--field <名称>` | `created` \| `lastActivity` \| `lastMessage` \| `mtime` \| `activity`（区间内有活动）（默认 `lastActivity`） |
| `--from <时间>` | 起始时间（含），本地时区 |
| `--to <时间>` | 结束时间（不含），本地时区 |
| `--include-archived` | 同时包含 `.pideck-archive` 归档会话 |
| `--cwd <通配符>` | 匹配工作目录，例：`"*\\项目\\*"` |
| `--grep <关键词>` | 匹配 名称 / 预览 / 工作目录 / 会话 ID |

## 目录结构

```
pi-sessions/
├─ bin/pi-sessions.mjs   CLI 入口
├─ src/
│  ├─ paths.mjs          sessions 根目录解析（对齐 pi 优先级）
│  ├─ scanner.mjs        收集 *.jsonl（根 + 一层子目录）
│  ├─ parser.mjs         流式元数据 + 完整轮次解析
│  ├─ filter.mjs         字段 × [from,to) 过滤
│  ├─ report.mjs         表格 / JSON / CSV 输出
│  ├─ export.mjs         JSONL 复制 / Markdown / HTML
│  ├─ server.mjs         轻量 http + JSON 接口
│  └─ cli.mjs            参数解析与命令分发
└─ public/               网页界面（index.html、app.js、style.css）
```

## 说明

- 只读保证：唯一的写操作是导出目录、`--save` 文件，以及网页服务的内存缓存。源会话文件只会被读取。
- 损坏或未写完的行会被跳过；以最后一条有效记录为准。

## 许可证

[MIT](LICENSE) © 2026 Wukaixong
