# 路线 A：用 ChatGPT 网页版遥控本机 DSH

这条路线用现成的成品 [Codex Bridge](https://github.com/Fanch-hui/codex-bridge)，不写代码。目标是在 ChatGPT 网页版里说一句话，本机 DSH 在自己的项目目录里执行，过程回到 ChatGPT。

**做完之后你会得到**：ChatGPT 里能列出你授权的项目、能查本机 Agent 状态、能派任务给 DeepSeek Harness，动文件和跑命令需要你在本机点批准。

---

## 需要准备什么

| 项 | 要求 |
| --- | --- |
| ChatGPT | **Plus 及以上**（或团队订阅）。Secure MCP Tunnel 不对免费号开放。 |
| 网络 | 能访问 `platform.openai.com` 和 `chatgpt.com`。国内直连不通时，准备好本机 HTTP 代理地址（例如 `http://127.0.0.1:7897`）——注意必须是 HTTP/HTTPS 代理，SOCKS 端口不行。 |
| 系统 | Windows x64 / ARM64、macOS 14+、Ubuntu 24.04。 |
| DeepSeek API Key | 接 DSH 时才要，`platform.deepseek.com/api_keys`。 |

装两样东西：Codex Bridge（桌面 App）、DeepSeek Harness。**不要**自己架隧道——App 里已经随包带了 `tunnel-client`。

---

## 1. 装 Codex Bridge

从 [Releases](https://github.com/Fanch-hui/codex-bridge/releases/latest) 下载对应安装包（写这份文档时最新是 v2.0.4）：

- Windows：`CodexBridge-Windows-x64-2.0.4-Setup.exe`（ARM64 用 `arm64` 那个）
- macOS：`CodexBridge-2.0.4-macos-arm64.dmg` / `-x86_64.dmg`
- Ubuntu：`CodexBridge-Linux-x64-2.0.4.deb`

装完启动，在「概览」里确认**后台 Service 已连接**。关掉主窗口会缩到托盘（Windows），别当成退出了。

> 卡在这就别往下走。Service 没起来，后面每一步都是白做。

## 2. 登记项目目录

左侧「项目」→ 添加项目 → 选你要让 agent 干活的目录。

**登记就等于授权完整访问**，所以只登记项目目录，不要登记整个用户目录或盘符根目录。

回到「工作台」，把这个项目选为默认项目。远程客户端省略 `project_id` 时用的就是它。

## 3. OpenAI Platform：建 Tunnel 和 Runtime Key

三个凭据别搞混：**Tunnel ID**、**Runtime API Key**、**DeepSeek API Key**。前两个在 OpenAI 平台，第三个在 DeepSeek 平台。

**建 Tunnel**

1. 登录 [platform.openai.com](https://platform.openai.com/)，切到你要用的组织。
2. 打开 [Tunnels](https://platform.openai.com/settings/organization/tunnels)，新建一个，名字随意（如 `Codex Bridge`）。
3. **在 WORKSPACES 里勾选你实际使用的 ChatGPT 工作区并保存。个人号选 Personal，团队号选对应工作区。这一项必须选，留空等于白建。**
4. 复制 Tunnel ID（`tunnel_` + 32 位小写字母数字）。

**建 Runtime Key**

5. 打开 [API Keys](https://platform.openai.com/settings/organization/api-keys)，新建 key，权限选 **Restricted**，在 Tunnels 权限里勾上 **Read** 和 **Use**。
6. 建完立刻复制（只显示一次）。

> 权限提示：创建/编辑 Tunnel 需要 Tunnels 的 Read + Manage；运行 Helper 和在 ChatGPT 里选 Tunnel 需要 Read + Use。

## 4. 在 Bridge 里启动连接

「连接 → 远程 AI 客户端 (OpenAI Secure Tunnel)」：

1. **Tunnel ID** 填第 3 步复制的 ID。
2. **Runtime Key** 填刚建的 key（不要带引号、空格、换行）。
3. 需要代理的话，同一个页面填「Tunnel HTTP(S) 代理」，例如 `http://127.0.0.1:7897`，点保存代理。
4. 点「保存并启动连接」。

**验收标准**：状态变成 `ready`，并且「远程任务接收」显示为允许。

| 状态 | 含义 |
| --- | --- |
| `ready` + 接收允许 | 通过，继续下一步 |
| 只显示「Helper 就绪」 | **不算通过**，那只说明组件存在 |
| `starting` / `authenticating` / `connecting` | 等，或看日志诊断 |
| `degraded` | 临时异常，会自动退避重连 |
| 需要检查凭据 / `failed` | 核对 key、组织、Tunnel ID、网络 |

Key 填进去后输入框会清空，这是正常的（存进系统凭据管理器了）。

## 5. 在 ChatGPT 里添加插件

1. ChatGPT 侧栏打开「插件」。
2. 右上角「添加」→「创建自定义 MCP 服务器」，名字填 `Codex Bridge`。
3. **连接类型选 Tunnel**（不是填 URL），选第 3 步那个 Tunnel，或粘 Tunnel ID。
4. 完成工具扫描，保存。
5. 新建对话，从输入框加号菜单里选中 Codex Bridge。

**验收**：发这句

```
请使用 Codex Bridge 调用 bridge_status，然后列出已登记项目。
```

返回的项目名和数量必须和第 2 步登记的**对得上**。返回"找不到工具"、空回复、报错都算没过。

## 6. 接 DeepSeek Harness

两种接法，选一种：

**A. 官方桌面版（新手推荐）**
1. 从 [DSH Releases](https://github.com/deepseek-ai/deepseek-harness/releases) 装官方桌面，先启动一次完成初始化。
2. **完全退出** DSH 桌面。
3. Bridge「连接 → DSH 桌面」→「安装连接器」→「连接」。
4. 核对两边相同的配对确认码，在 DSH 的 Codex Bridge 插件面板里允许。
5. 显示「已连接」后，选项目、模型，权限选「完整」。

**B. 命令行版（ACP）**
1. Bridge「工作台 → DSH 开发台 → 引擎设置」→ 点「扫描 Agent」，或点「一键配置」让它准备官方 DSH 和 Node/npm。
2. 连接行填 Base URL `https://api.deepseek.com` 和 DeepSeek API Key → 点「连接」，等 Probe 通过。

手动装源码版的话：

```bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
```

登记 `<dsh-source>/apps/cli/lib/bin.js` 的**绝对路径**。别把 bin.js 单独拷走——它要靠同目录的 `package.json`、依赖锁文件和 `node_modules` 才能跑。

**两个必须知道的约束**：

- Node 版本要 `^22.19.0` 或 `>=24.0.0`。**不支持 22.18.x 和 23.x。**
- **DSH 的任务权限必须选「完整」**。它目前的执行入口做不到任务级工具禁网，所以「只读」会被明确拒绝——这不是 bug。要只读任务就用 Codex 那条线。

**验收**：引擎设置显示已连接，**并且**刷新模型目录后能列出至少一个真实模型名。只有前者不算过。

## 7. 第一次真实任务

先在 Bridge 工作台选好项目、Agent 选 DeepSeek Harness、权限「完整」。然后在 ChatGPT 里：

```
使用 DeepSeek Harness 检查当前项目，列出目录结构并总结 README，不要改任何文件。
```

默认远程任务会等本机批准：「工作台」会弹批准卡片，核对项目和任务内容后点批准。**批准启动**和**执行期工具审批**是两件事，后面再问还要再点。

**验收**：ChatGPT 侧收到的结论和 Bridge 侧任务输出对得上；如果任务改了文件，你去那个目录能查到改动。查不到 = 没真跑。

---

## 备份路线：没有 ChatGPT Plus

Codex Bridge 同时支持 Qwen Studio，走**本机回环 MCP**，不需要 Tunnel，也不需要 OpenAI 那三样凭据。能力弱一点，但"操作/执行分离"的结构能先跑起来。

---

## 排错表

| 症状 | 处理 |
| --- | --- |
| 看不到 Tunnels / 建不了 | 确认组织和 Tunnels 的 Read + Manage 权限 |
| **Tunnel 建了，但 ChatGPT 的隧道列表里找不到** | 九成是 WORKSPACES 没选。回平台编辑该 Tunnel 勾选目标工作区并保存，再回同一工作区刷新列表 |
| 找不到「创建自定义 MCP 服务器」 | 侧栏打开「插件」看右上角「添加」；受管工作区要检查账号权限和管理员设置 |
| 保存时报配置无效 | 重新复制 Tunnel ID；key 不带引号空格换行 |
| 一直认证失败 | 核对 key 的组织、是否被撤销、Tunnels 是否有 Read + Use |
| 连接反复掉线 | 检查本机到 OpenAI 的出站 HTTPS 与代理配置 |
| Bridge 显示 ready，但扫描工具失败 | 保持 Service 在跑；核对两端 ID、工作区、连接类型 |
| 工具能扫描，任务不执行 | 当前对话里要选中 Codex Bridge 插件；Refresh tools 后新开对话 |
| 一直提示等待本机审批 | 去 Bridge 工作台点批准 |
| DSH 返回「不支持只读」 | 正常。把任务权限改成「完整」 |
| 升级后还在用旧工具 | 插件详情页点 **Refresh tools** → 新开对话 → 重新选中插件 → 发 `请调用 bridge_status 查看当前状态` |

---

## 出处

以下内容来自 [Fanch-hui/codex-bridge](https://github.com/Fanch-hui/codex-bridge)（Apache-2.0，默认分支 `win`）的仓库文档，版本 v2.0.4，抓取于 2026-10-16：

- `docs/CHATGPT_DEVELOPER_MODE.md` — Tunnel、Runtime Key、ChatGPT 插件配置
- `docs/DEEPSEEK_HARNESS_CONNECTION_GUIDE.md` — DSH ACP 接入
- `docs/DSH_NATIVE_DESKTOP_GUIDE.md` — DSH 官方桌面接入
- `docs/USER_GUIDE.md` — 项目登记、任务权限、审批

OpenAI 官方隧道说明：<https://developers.openai.com/api/docs/guides/secure-mcp-tunnels>
