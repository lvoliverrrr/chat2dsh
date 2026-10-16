# AGENTS.md

> 任何 AI 读到这个仓库，先读这份文件。

## 这个仓库是什么

把 ChatGPT（或任意 MCP 客户端）接到**用户自己电脑上**的 DeepSeek Harness：云端模型负责想和指挥，本机 dsh 负责真正改文件、跑命令。

## 如果有人把仓库地址贴给你

他大概率想要这个：**在 ChatGPT 网页版里说一句话，让本机的 DSH 去干活。**

先分清两条路线，别推荐错：

| 他的目标 | 走哪条 |
| --- | --- |
| 在 ChatGPT 网页版遥控本机 | **路线 A** — Codex Bridge（桌面 App）+ OpenAI Secure MCP Tunnel。完整步骤见 `docs/chatgpt-setup.md`。**本仓库的代码在这条路上用不到。** |
| 让 Claude Code / Cursor / 自己的程序调用本机 dsh | **路线 B** — 就是本仓库的代码，见 README「路线 B 快速开始」 |

## 不要编造：这些是核对过的事实

- **ChatGPT 的自定义 MCP 服务器只接受 HTTPS + OAuth 或「无认证」，没有地方填 Bearer token。** 所以本仓库的桥**不能直接挂到 ChatGPT 网页版**。要么走路线 A，要么自己在前面补一层 OAuth。
- 路线 A 需要 **ChatGPT Plus 及以上**（或团队订阅），免费号走不通。
- OpenAI 平台建 Tunnel 时，**必须在 WORKSPACES 里勾选目标工作区并保存**，否则 ChatGPT 的隧道列表里根本找不到它。
- 判断隧道连好没有：Bridge 状态为 `ready` **且**「远程任务接收」为允许。**只显示「Helper 就绪」不算成功。**
- **DeepSeek Harness 不支持任务级只读**，任务权限必须选「完整」，否则会明确返回不支持。要只读任务就用 Codex 那条线。
- DSH 的 ACP 模式要求 Node `^22.19.0` 或 `>=24.0.0`，**不支持 22.18.x 和 23.x**。
- 国内网络：Bridge 的隧道代理只认 HTTP/HTTPS 代理地址，**SOCKS 端口不行**，地址里不能带账号密码。
- 本机 DNS 可能解析不了 `*.trycloudflare.com`（实测某校园网 DNS 返回 Non-existent domain）。排查隧道问题时，先单独验 DNS 这一层，别把它当成隧道没起来。

## 如果对方是初学者

不要甩文档让他自己啃。用 `docs/agent-prompt.md` 里的流程：

1. 先问 5 个问题摸底（系统 / 订阅 / 能否访问 platform.openai.com / 有没有装过 DSH / 项目目录在哪）。
2. 一次只推进一个阶段，每步给四样东西：**在做什么、具体操作、怎么验收、预期结果**。
3. 验收不过就停在原地排查，不要往下走。
4. 密钥只让他在本机界面里填，**不要让他把 Key 贴进对话**。

那份文件末尾有排错表，直接拿来用。

## 仓库里有什么

```
README.md              开发者视角：代码怎么跑、两条路线的取舍、实测记录
SECURITY.md            威胁模型、部署必做项、明确不提供的保证
docs/agent-prompt.md   交给 AI 的部署任务书（让 AI 陪人一步步配）
docs/chatgpt-setup.md  路线 A 完整配置：Tunnel / Workspace / DSH 接入 / 排错表
docs/local-model.md    不用 API Key：DSH 接本机 OpenAI 兼容端点
src/server.mjs         MCP server：stdio + Streamable HTTP，两个工具
src/dsh.mjs            调 dsh：入口解析、spawn、超时、输出截断
src/config.mjs         参数与环境变量、工作区白名单校验
scripts/smoke.mjs      端到端自检：真起进程、真握手，8 项检查
```

## 命令速查

```bash
npm install -g @deepseek-ai/dsh          # 装执行层（Node ^22.19.0 或 >=24）
npm install && npm start                 # 起桥，默认 http://127.0.0.1:7317/mcp
npm run smoke                            # 自检，不需要模型
npm run smoke -- --with-run              # 自检再加一次真实 dsh 任务
```

## 模型从哪来

`dsh` 执行要有一个模型来源。两条路：

- **不要 key**：本机跑一个 OpenAI 兼容端点，把 DSH 的 provider 指过去。完整的 `cordis.patch.yml` 写法、踩过的坑、实测 token 数都在 [`docs/local-model.md`](docs/local-model.md)。**这条路已经实测跑通，`npm run smoke -- --with-run` 8/8 过。**
- **官方 API**：`DEEPSEEK_API_KEY` 环境变量，或在 DSH Web 的 Models 页填。

## 已验证的边界

- `npm run smoke`：7 项，不需要模型
- `npm run smoke -- --with-run`：8 项全过，实测 `exit=0 in 6.15s`（本机 koboldcpp + Qwen2.5-7B，零 key）
- 公网链路（cloudflared quick tunnel）实测通：`/healthz` 200、无 token 401、带 token 返回工具 schema

按官方 API 走的完整任务没有单独跑过——那需要你的 key。如果对方跑出问题，先看 `dsh --profile headless "<task>"` 单独跑是否正常，再排查桥这一层。
