# chat2dsh

> **AI 助手正在读这个仓库？先看 [`AGENTS.md`](AGENTS.md)。** 那里写了哪条路线适合你的用户、哪些事实不能编、以及面对初学者该怎么带。

把 ChatGPT（或任意 MCP 客户端）接到你自己电脑上的 **DeepSeek Harness**：云端模型负责想和指挥，本机 DSH 负责真正改文件、跑命令。

Operation and execution separated — the chat model plans, the local DSH agent executes.

```
ChatGPT 网页版 / 任意 MCP 客户端        ← 操作层：派活、定约束、看结果
      │  OpenAI Secure MCP Tunnel / HTTPS / stdio
      ▼
chat2dsh（本仓库的轻量桥）              ← 桥接层：目录白名单、工具暴露、输出回传
      │  本机调用
      ▼
DeepSeek Harness (dsh headless)         ← 执行层：读改文件、跑命令、跑测试
```

---

## 先选路线，别两头做

| | 路线 A：Codex Bridge | 路线 B：本仓库 chat2dsh |
| --- | --- | --- |
| 形态 | 桌面 App（Swift，含安装包） | 一个 Node 脚本，无 GUI |
| 接 ChatGPT 网页版 | **可以**，走 OpenAI Secure MCP Tunnel | **不可以**（见下方限制） |
| 接 Claude Code / Cursor / Codex CLI | 可以 | 可以 |
| 审批 / 任务记录 / 多 Agent | 有 | 无 |
| 适合 | 主要目标是「在 ChatGPT 里遥控本机」 | 主要目标是「让本机 agent 被任意 MCP 客户端调用」 |

**如果目标就是 ChatGPT 网页版遥控本机，用路线 A**，见 [`docs/chatgpt-setup.md`](docs/chatgpt-setup.md)（含 Tunnel、Workspace、DSH 接入的完整步骤和踩坑清单）。本仓库的代码不是那条路的必需品。

**不想自己啃文档？** 把 [`docs/agent-prompt.md`](docs/agent-prompt.md) 里那段提示词整段发给一个 AI（ChatGPT、Claude 都行），它会先问你几个问题，然后一个阶段一个阶段带你配，每步都告诉你验收标准。那是这份 README 的口语版。

**路线 B 的限制，先说清楚**：ChatGPT 的自定义 MCP 服务器只接受 HTTPS + OAuth 或「无认证」两种方式，没有地方填 Bearer token。所以本仓库这个桥直接挂到 ChatGPT 上，要么走无认证的公网隧道（谁拿到 URL 谁能执行你电脑上的代码），要么你自己在前面补一层 OAuth。两种情况都不该按默认做法用。**它真正的用途是给本机或局域网里的 MCP 客户端当 dsh 适配器**，以及当你要自己实现一个带 OAuth 的 ChatGPT 网关时，作为被包在里面的那一层。

---

## 路线 B 快速开始

```bash
# 1. 装 DeepSeek Harness（需要 Node ^22.19.0 或 >=24）
npm install -g @deepseek-ai/dsh

# 2. 装本仓库
git clone https://github.com/lvoliverrrr/chat2dsh.git
cd chat2dsh
npm install

# 3. 配一个 token 和白名单目录
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # 填进 CHAT2DSH_TOKEN
# 再把 CHAT2DSH_ROOTS 改成你要让 agent 干活的项目目录

# 3.5 填 DSH 的 key
# 打开 .env，把 DEEPSEEK_API_KEY= 那行取消注释填上。不填也能跑，但 dsh_run 会返回
# MISSING_CREDENTIAL —— 桥是好的，只是 dsh 没有模型可用。

# 4. 起服务（HTTP 模式）
npm start
# [chat2dsh] v0.1.0 listening on http://127.0.0.1:7317/mcp
# [chat2dsh] dsh: 0.2.0-rc.2 (.../@deepseek-ai/dsh/lib/bin.js)
# [chat2dsh] roots: C:\Users\me\projects\demo
# [chat2dsh] auth: bearer token required

# 5. 自检
npm run smoke             # 握手 + tools/list + dsh_health + 越界拦截
npm run smoke -- --with-run   # 再加一次真实 dsh 任务（要花一次模型调用）
```

`dsh` 执行本身需要 API Key。用官方的：`platform.deepseek.com/api_keys` 拿 key，填在 DSH Web 的 Models 页（写进 `~/.dsh/.credentials.yaml`），或者直接作为环境变量 `DEEPSEEK_API_KEY` 传给本桥。

---

## 工具

桥只暴露两个工具，够用就行。

### `dsh_health`
只读。返回 dsh 是否可达、版本、Node 版本、DSH_HOME、配置的工作区白名单、凭据文件是否存在。**先调它**，确认桥接层是活的。

### `dsh_run`
把**一个自包含任务**交给本机 DSH 执行，阻塞到结束，返回 stdout、stderr 尾部、退出码、耗时。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `task` | 是 | 完整任务描述。**必须自包含**——headless 是一次性会话，agent 看不到你和它的上一轮对话，也问不了追问。把目标、涉及文件、约束、期望输出都写进去。 |
| `cwd` | 否 | 绝对路径，必须落在 `CHAT2DSH_ROOTS` 白名单内。省略则用白名单第一项。 |
| `timeout_ms` | 否 | 墙钟上限。默认 300000，硬上限 1800000。 |

任务在 `cwd` 里执行，DSH 用启动目录作为它的工作区根。

---

## 接到 MCP 客户端

**Claude Code**

```bash
claude mcp add-json chat2dsh -s user '{"type":"stdio","command":"node","args":["<abs>/chat2dsh/src/server.mjs","--stdio","--root","<workspace>"]}'
```

**Cursor / 任意 JSON 配置的客户端**

```json
{
  "mcpServers": {
    "chat2dsh": {
      "command": "node",
      "args": ["<abs>/chat2dsh/src/server.mjs", "--stdio", "--root", "<workspace>"],
      "env": { "DEEPSEEK_API_KEY": "..." }
    }
  }
}
```

**HTTP 模式**（本机或局域网，Bearer 认证）

```bash
node src/server.mjs --http --port 7317 --token <secret> --root <workspace>
```

```
POST http://127.0.0.1:7317/mcp
Authorization: Bearer <secret>
```

无状态实现：每个 POST 独立，不维护 session，`GET`/`DELETE` 返回 405。`GET /healthz` 是不带凭据的存活探测，只回版本，不回任何敏感信息。

---

## 实测记录

2026-10-16，Windows 11 + Node v22.22.2 + DSH v0.2.0-rc.2，`npm run smoke`：

```
PASS  server boots and binds loopback — bridge 0.1.0, dsh 0.2.0-rc.2
PASS  dsh is reachable from the bridge process — resolved
PASS  unauthenticated request is rejected — HTTP 401
PASS  MCP handshake over Streamable HTTP — session 89ed50d7
PASS  tools/list returns the bridge surface — dsh_health, dsh_run
PASS  dsh_health reports a real dsh runtime — dsh 0.2.0-rc.2 @ .../@deepseek-ai/dsh/lib/bin.js
PASS  dsh_run refuses a cwd outside the roots — cwd "..." is outside the allowed roots
SKIP  dsh_run live task — pass --with-run to spend one real LLM call

7/7 checks passed
```

同一台机器上直接跑 `dsh headless "<task>"`（未配 key），14 秒返回：

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
```

**公网链路**（同一台机器，`cloudflared tunnel --url http://127.0.0.1:7317`，quick tunnel）：

```
$ curl https://<random>.trycloudflare.com/healthz
{"ok":true,"bridge":"0.1.0","dshVersion":"0.2.0-rc.2","authRequired":true}

$ curl -X POST https://<random>.trycloudflare.com/mcp -d '{"method":"tools/list",...}'
{"error":"unauthorized"}                       # HTTP 401，没带 token

$ curl -X POST https://<random>.trycloudflare.com/mcp \
    -H 'authorization: Bearer <token>' -d '{"method":"tools/list",...}'
event: message
data: {"result":{"tools":[{"name":"dsh_health",...},{"name":"dsh_run",...}]}}
```

也就是说 **公网 HTTPS → Cloudflare 边缘 → 隧道 → 本机桥 → dsh 解析** 这一段是实测通的。
顺带一个环境发现：本机（校园网）的 DNS 不解析 `*.trycloudflare.com`，nslookup 报 Non-existent domain，
换阿里 DNS 才拿到 Cloudflare 边缘 IP。你要是在类似网络里用自建隧道，先确认 DNS 这一层，
或者干脆走官方 Secure MCP Tunnel。

三件事说清楚了：**桥接层、dsh 进程链路、公网可达性都真跑过**；
**唯一没跑的是带 API Key 的真实模型调用**——那一步需要你自己的 key，`npm run smoke -- --with-run` 一跑就见分晓。

---

## 暴露到公网（可选，先读下面「安全」那节）

```bash
# 临时域名，不用注册账号
cloudflared tunnel --url http://127.0.0.1:7317
# 它会打印 https://<random>.trycloudflare.com
# 你的 MCP 端点就是它后面加 /mcp
```

三件事先知道：

- 这个域名**每次重启都变**，而且没有可用性保证。要稳定域名用命名隧道，要接 ChatGPT 就用官方 Secure MCP Tunnel。
- **本机 DNS 可能根本解析不了 `*.trycloudflare.com`。** 实测某校园网 DNS 直接返回 Non-existent domain，换 `223.5.5.5` 才解析到 Cloudflare 边缘 IP，再用 `curl --resolve host:443:IP` 才通。排障时先单独验 DNS 这一层，别把它当成隧道没起来。
- 公网暴露意味着**谁拿到 URL 又拿到 token，谁就能在这台机器上执行代码**。只给信任的人，用完就关。

## 安全

这个桥的存在意义就是**让远端在本机执行代码**，所以边界要自己划清楚：

- **默认只绑 `127.0.0.1`**。绑到别的地址会打印警告，别无视它。
- **HTTP 模式没有 token 就不启动**。除非你显式 `--no-auth`，而且要清楚那意味着同网段谁能访问谁就能执行。
- **`CHAT2DSH_ROOTS` 是白名单，不是建议**。越界的 `cwd` 会被拒绝（自检里有这一条）。别把整个用户目录或盘符根目录写进去。
- **别把带 token 的隧道 URL 发出去**。ChatGPT 那条路请用官方 Secure MCP Tunnel，不要自己拿 `trycloudflare` 的临时地址裸奔。
- 输出默认截断在 64 KB（`CHAT2DSH_MAX_OUTPUT`），超时上限 30 分钟。

---

## 目录结构

```
chat2dsh/
├── README.md        开发者视角：代码怎么跑、实测记录
├── AGENTS.md        给 AI 的入口 —— AI 进仓库先读这个
├── SECURITY.md      威胁模型、部署必做项、不提供的保证
├── llms.txt         给 LLM 的文档索引
├── src/
│   ├── server.mjs   MCP server：stdio + Streamable HTTP，两个工具
│   ├── dsh.mjs      调 dsh：入口解析、spawn、超时、截断
│   └── config.mjs   参数与环境变量、白名单校验
├── scripts/
│   └── smoke.mjs    端到端自检（真起进程、真握手）
├── docs/
│   ├── chatgpt-setup.md  路线 A：ChatGPT 网页版 + Codex Bridge 完整配置
│   └── agent-prompt.md   交给 AI 的部署任务书（让它带你一步步配）
├── .env.example
└── package.json
```

## 为什么不用 shell 调 dsh

`dsh` 在 Windows 上是 `.cmd` shim，任务文本要经过 cmd.exe 的引号转义规则。所以 `src/dsh.mjs` 解析出 npm 包的 JS 入口（`@deepseek-ai/dsh/lib/bin.js`），直接 `node <entry> <profile> <task>`。任务作为真正的 argv 元素传递，不经过 shell，没有转义地狱，也没有注入面。解析不到入口时才退回 shell 模式。

## License

MIT
