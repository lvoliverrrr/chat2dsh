# 不用 API Key：把 DSH 接到本机模型

DSH 默认走 `deepseek-official`（Anthropic Messages 协议，`https://api.deepseek.com/anthropic`）。本机跑 llama.cpp / koboldcpp / Ollama 这类 OpenAI 兼容端点时，要用 `dsh-llm-pi-ai` 这个插件手写一条 provider 路由——它支持 `openai-completions`，而这正是绝大多数本机推理服务器说的协议。

`dsh-llm-pi-ai` 已经由 `@deepseek-ai/dsh-base` 挂载进树里，只是默认处于"休眠"状态（`providers` 为空）。给它一段 `providers` 配置就活了。

---

## 1. 起模型服务

以 koboldcpp + Qwen2.5-7B 为例（Windows，8GB 显存的笔记本 GPU）：

```cmd
koboldcpp.exe --model D:\models\Qwen2.5-7B-Instruct-Q4_K_M.gguf ^
  --gpulayers 33 --contextsize 32768 --port 5001 --host 127.0.0.1 --skiplauncher
```

验证：

```bash
curl -s http://127.0.0.1:5001/v1/models
# {"object":"list","data":[{"id":"koboldcpp/Qwen2.5-7B-Instruct-Q4_K_M",...,"status":{"value":"loaded"}}]}
```

`--host 127.0.0.1` 别省。DSH 就在本机，不需要对外监听。

> **上下文能开多大就开多大。** 见下面第 4 节——模型光工具定义就可能吃掉两万多个 token。

## 2. 加一条 provider 路由

写进 `~/.dsh/cordis.patch.yml`（**home 层**：对每个 profile 都生效，且优先级高于 `profiles/<name>/cordis.patch.yml`）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      local:                                   # 路由名，随便起
        displayName: 本机 koboldcpp · Qwen2.5-7B
        apiKeyEnv: KOBOLD_API_KEY              # 只是个"引用名"，见第 3 节
        api: openai-completions                # 只支持 openai-completions / openai-responses / anthropic-messages
        baseURL: http://127.0.0.1:5001/v1
        timeoutMs: 600000
        streamIdleTimeoutMs: 600000
        defaultContextWindow: 32768
        defaultMaxTokens: 8192
        defaultInput:
          - text
        models:
          - id: koboldcpp/Qwen2.5-7B-Instruct-Q4_K_M   # 必须和 /v1/models 报的 id 一字不差
            name: Qwen2.5-7B-Instruct (koboldcpp)
            contextWindow: 32768
            input:
              - text
            reasoningEfforts: false            # 非推理模型，明确声明，别让它去试 reasoning 参数
```

再把默认模型指过去：

```yaml
- id: agent-default-model
  config:
    provider: local
    model: koboldcpp/Qwen2.5-7B-Instruct-Q4_K_M
```

改完先**不启动**地验证一遍组装结果：

```bash
dsh --profile headless --dump-config | grep -A 20 'llm-pi-ai'
dsh --profile headless --dump-config-schema > /dev/null   # 顺便当 schema 校验，出错会非零退出
```

### 两个容易踩的坑

**`maxTokens` 放在模型条目上会变成"每次请求的默认上限"。** 官方 schema 的原话是 *"Configuring one also makes it this model's per-request default"*。如果你写 `maxTokens: 4096`，而某一轮的 prompt 是 29010 tokens、窗口是 32768，那么 `29010 + 4096 > 32768`，这一轮直接崩。想只声明"这个模型最多能吐多少"而不设请求默认，就把值放到**路由级**的 `defaultMaxTokens` 上——路由级的值是能力声明，不会变成请求默认。

**`baseURL` 要带 `/v1`。** pi-ai 的 `openai-completions` 会往后面拼 `/chat/completions`。

## 3. 塞一个占位 key

就算端点根本不校验 key，也得有一个。pi-ai 的 OpenAI 兼容实现在这一层是硬性的：省略 `apiKeyEnv` 等于"这个路由故意不认证"，于是 auth 是空的，请求还没发出去就报

```
dsh: PI_AI_ERROR: No API key for provider: local
```

（`dsh-llm-pi-ai` 自己的注释说得很直白：*"pi-ai's OpenAI-compatible implementation, for one, still insists on a key or an `Authorization` header of its own."*）

`apiKeyEnv` 写的是一个**环境变量名**，值从 `ctx.credentials` 解出来，顺序是：

1. 启动进程继承的环境变量（只读，最高）
2. `~/.dsh/.credentials.yaml` 的 `refs:` 段 ← **推荐放这里，跨启动器都能读到**
3. 项目 / 家目录的 `.env` 兜底

所以：

```yaml
# ~/.dsh/.credentials.yaml
version: 1
refs:
  KOBOLD_API_KEY: sk-local-koboldcpp
records:
  ...   # 原有记录保持不动
```

这个文件是热监听的，改完不用重启。**这只是占位值，不是密钥**——本机端点不校验它。

> 也可以反过来完全不碰凭据文件：把 `apiKeyEnv` 去掉，改成 `headers: {Authorization: "Bearer sk-local"}`。少一个文件，但那样这个路由就不会出现在 DSH Web 的 Models 页里。

## 4. 先量 prompt，再看模型够不够大

这是这条路最容易翻车的地方，而且是静默的：**DSH 会把所有已挂载工具的 schema 塞进 system prompt。**

实测（同一台机器）：

| 配置 | inputTokens | 结果 |
| --- | --- | --- |
| 开着 `rea` MCP（Ghidra 逆向工具集） | **29,010** | 16384 窗口下直接崩；32768 下能出字但 `turn_end.reason` 是 `max-tokens`，退出码 1 |
| 关掉 `rea` | **3,446** | `reason: completed`，退出码 0 |

`rea` 一个人贡献了 25,564 个 token。对 32k 窗口来说，剩下的空间只够问一句话；对 7B 模型来说，两百多个工具本来就选不对。

按 profile 关掉这类重型 MCP，在 home 层那个 insert 条目上挂一个 `!!js` 判断就行：

```yaml
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      disabled: !!js "ctx.get('profileContext')?.name === 'headless'"
      config:
        ...
```

**注意不能写在 `profiles/<name>/cordis.patch.yml` 里。** patch 的叠加顺序是「bundle → profile 层 → home 层 → `--patch` 覆盖层」，profile 层跑在前面，那时 `rea-mcp` 还不存在，会报 `patch: entry "rea-mcp" not found`。只有 `--patch` 覆盖层和 home 层能看到 home 层插入的条目。

想临时试一下，不改任何文件：

```bash
echo '- id: rea-mcp\n  disabled: true' > /tmp/no-rea.yml
dsh --profile headless --patch /tmp/no-rea.yml --json "Say OK"
```

## 5. 验证

`--json` 输出逐行的 run 事件，比猜有用得多：

```bash
dsh --profile headless --json "Reply with exactly this text and nothing else: LOCAL MODEL OK"
```

```
{"type":"text","text":"OK"}
{"type":"status","phase":"step_end","usage":{"inputTokens":3446,"outputTokens":40,"totalTokens":3486}}
{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}
{"type":"final","text":"OK"}
```

看三样东西：

- `usage.inputTokens` —— 就是上面第 4 节要量的数
- `turn_end.reason.kind` —— 正常是 `completed`；`max-tokens` 说明 prompt + 输出预算撑破了窗口
- 退出码 —— 非 `completed` 的 turn 退出码是 1，答案照样会写到 stdout，但那是残缺的

然后用本桥跑一次真的：

```bash
npm run smoke -- --with-run
# PASS  dsh_run executed a real task through the bridge — exit=0 in 6.15s
# 8/8 checks passed
```

## 6. 换回官方 API

把 `~/.dsh/cordis.patch.yml` 里 `agent-default-model` 的 `provider` 改回 `deepseek-official`、`model` 改成 `deepseek-flash`，然后按官方方式给 key（DSH Web 的 Models 页，或环境变量 `DEEPSEEK_API_KEY`）。`local` 那条路由留着不影响——DSH Web 的模型选择器里会同时列出两条，随时切。

## 附：排查的时候有用的东西

- **会话记录**是 zstd 压缩的 JSONL：`~/.dsh/sessions/<路径 slug>/session-<id>/session.v4.jsonl.zstd`。Node 里 `zlib.zstdDecompressSync` 能解，但**只解第一帧**——多帧追加的文件要用流式的 `createZstdDecompress`。
- **`--session-id <id>`** 可以接上一个已有 Session 继续问，比每次重开省一大截 prompt 处理时间。
- **服务端日志更直接。** koboldcpp 会把收到的请求体打到 stdout，`Processing Prompt [BATCH] (N / M tokens)` 里的 M 就是这一轮的实际 prompt 长度——照 `usage.inputTokens` 对得上。
- **prompt 处理是主要开销。** 3.4k tokens 的 prompt 在这台笔记本上约 6 秒；29k tokens 时是 90 秒级别。省 token 就是省时间。
