# agentx 架构

## 总体分层

```
                        User
                         │
                 npx agentx <cmd>
                         │
                         ▼
            ┌──────────────────────────┐
            │   CLI 入口  src/cli.ts    │  ← 参数解析、命令分发
            └────────────┬─────────────┘
                         │
        ┌────────────────┼───────────────────────────────┐
        ▼                ▼                               ▼
  命令分发          配置加载/凭据                      启动 Adapter
  claude/codex     config.ts / credentials.ts         server.ts
  proxy/exec       runtime.ts                           │
  auth/usage/quota                                 [HTTP 本地服务]
  doctor/forget/                                  127.0.0.1:<port>
  version
```

## 客户端进程启动链路（Process Launcher）

```
cli.ts (claude/codex/proxy/exec)
   │
   ├─ ui.ts          runInteractiveLauncher（交互式 Provider/Model 选择，含 Add/Remove custom provider）
   ├─ config.ts      loadConfig（CLI 参数 > 环境变量 > 默认值）
   ├─ providers/registry.ts  providerById / apiKeyFor / registerCustomProvider / unregisterCustomProvider
   ├─ credentials.ts resolveCredential（--api-key > AGENTX_ 前缀变量 > 旧变量 > 交互输入）
   ├─ runtime.ts      saveDefaultRuntime / saveLastModel / saveCustomProvider（写入 ~/.config/agentx/runtime.json，不含 Key）
   │
   ├─ server.ts      startAdapter() → 生成本地随机 token，绑定回环端口
   │                     ├─ /health
   │                     ├─ /v1/models
   │                     ├─ /v1/messages          (Anthropic)
   │                     ├─ /v1/responses         (OpenAI Responses)
   │                     └─ /v1/chat/completions  (OpenAI Chat Completions)
   │
   └─ process.ts     runCommand(executable, args, env)  注入环境变量、转发 stdio、清理
        claude  → ANTHROPIC_* (本地 token)
        codex   → OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL
        exec    → 默认 Anthropic 形状；--client-protocol openai 切换为 OpenAI 形状
```

`--native`（claude/codex 专属）完全跳过上述解析链——不做 Provider/Model 解析、不启动 Adapter、不注入环境变量，直接以继承环境启动真实客户端；详见 README「Native launch」。

## 本地 Adapter 协议转换（server.ts + catalog.ts + convert/ + streaming/）

```
Claude Code (Anthropic Messages API)
      │  POST /v1/messages   Bearer <本地随机 token>
      ▼
  server.ts  (校验本地 token，不转发给上游；按 config.retry 对 429/502/503/504 做指数退避重试)
      │
      ├─ catalog.ts  providerFor（按 model 选路由；纯路由模块，不含转换函数）
      │
      ├── provider.protocol === "responses"
      │       └─ convert/responses.ts  toResponsesRequest / fromResponsesResponse
      │                            Anthropic ↔ Responses 转换
      │
      ├── provider.protocol === "chat-completions"
      │       └─ convert/chat.ts  toChatRequest / fromChatResponse（Anthropic ↔ Chat 转换）
      │       └─ 流式: streaming/chat-to-responses.ts, streaming/to-anthropic.ts
      │                            (Anthropic SSE ↔ OpenAI SSE)
      │
      └── provider.protocol === "anthropic"（自定义 Provider 专属，见下）
              └─ /v1/messages 侧零转换直接透传（两边协议一致）
              └─ /v1/responses 侧 convert/anthropic.ts  toAnthropicRequest / fromAnthropicResponse
              └─ 流式: streaming/anthropic-passthrough.ts, streaming/anthropic-to-responses.ts
```

`src/convert/` 是转换函数所在的模块化目录：`shared.ts`（跨方向 helper：图片/effort/thinking/tool-choice 映射、采样参数、JSON 解析）、`chat.ts`（上游 = Chat Completions 的全部方向）、`responses.ts`（上游 = Responses）、`anthropic.ts`（上游 = Anthropic，自定义 Provider 专属）、`index.ts`（barrel 导出，公共函数名不变）。`src/catalog.ts` 只保留 `providers`/`providerFor`/`honorRequestedModel` 路由函数。

`src/streaming/` 同样是拆分后的模块化目录（`common.ts` 收敛公共 SSE 写入/heartbeat/usage capture 逻辑，每条协议转换路径各占一个文件），不是单一的 `streaming.ts`。

## Provider 层（providers/registry.ts + types.ts）

```
                          ┌──────────────────────────────┐
                          │  Provider Registry            │
                          │  providerRegistry[]（运行时可变）│
                          └──────────────┬────────────────┘
                                         │
        ┌────────────────┬───────────────┼────────────────┬──────────────────┐
        ▼                ▼               ▼                ▼                  ▼
   opencode         deepseek       openrouter     用户注册的自定义 Provider（0..n 个）
   AGENTX_OPENCODE_API_KEY  AGENTX_DEEPSEEK_API_KEY AGENTX_OPENROUTER_API_KEY  AGENTX_<ID>_API_KEY
   （旧变量 OPENCODE_API_KEY 等仍兼容）
   gpt-5.6-luna 等   deepseek-v4-pro/flash  任意模型 id            protocol/baseUrl/model 由用户在
  → responses/       → chat-completions     → chat-completions      TUI 或 --base-url/--protocol 定义
    chat-completions                                                 三种协议任选（含 anthropic）
                                         │
                                         ▼
                                  上游 API（OpenCode / DeepSeek / OpenRouter / 任意兼容端点）
```

自定义 Provider 由 `registerCustomProvider()` 在运行时 push 进 `providerRegistry`（幂等，按派生 id 更新而非重复），`unregisterCustomProvider()` 移除；连接元数据（不含 Key）持久化在 `runtime.json` 的 `customProviders` 字段，进程启动时由 `hydrateCustomProviders()` 重新注册。

## 核心设计要点（实际实现）

- **无状态**：Adapter 不持久化对话，客户端每次请求携带全量上下文（server.ts）
- **凭据隔离**：真实 Key 只留在 Adapter 内，客户端只拿到每次启动随机生成的本地 token
- **工具调用**：只做协议转换（`tool_use`↔`function_call`、`tool_result`↔`function_call_output`），不在 Adapter 内执行
- **模型路由**：没有隐式 `auto` 路由（已移除）；运行时必须解析为具体模型，解析优先级见 README「Configuration」
- **上游重试**：`server.ts` 的 `forwardWithRetry` 对网络失败和 429/502/503/504 做指数退避重试（`--retry`/`AGENTX_RETRY`，默认 3，0 禁用），仅发生在流式传输开始之前
- **命令覆盖**：`claude`/`codex`/`proxy`/`exec`/`auth`/`usage`/`quota`/`doctor`/`forget`/`version`/`help`
- **可选集成**：`agentx quota --provider <id>` 查询 DeepSeek/OpenRouter 额度（OpenCode 返回"不支持"；`usage --provider` 为过渡期别名）；凭据只来自环境变量（`AGENTX_<PROVIDER>_API_KEY`，旧的无前缀变量兼容）

## 模块 → 职责映射

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 命令分发、参数解析、编排（`runAuthCommand`/`runDoctorCommand`/`runClientLaunch` 等具名函数） |
| `src/config.ts` | 配置加载与优先级 |
| `src/server.ts` | HTTP Adapter、认证、路由、重试、端口回退 |
| `src/catalog.ts` | 模型路由（`providers`/`providerFor`/`honorRequestedModel`），不含转换函数 |
| `src/convert/` | 协议转换函数，按上游协议拆分：`shared.ts`（跨方向 helper）、`chat.ts`（上游 = Chat Completions）、`responses.ts`（上游 = Responses）、`anthropic.ts`（上游 = Anthropic，自定义 Provider 专属）、`index.ts`（barrel） |
| `src/streaming/` | SSE 流式协议转换（按上游协议拆分成多个文件） |
| `src/providers/registry.ts` + `types.ts` | Provider 目录、模型注册表、自定义 Provider 注册/移除 |
| `src/process.ts` | 子进程启动/环境注入/stdio 转发/清理/`--native` 环境清洗 |
| `src/credentials.ts` | 凭据查找（CLI > `AGENTX_` 前缀环境变量 > 旧环境变量 > 交互输入） |
| `src/runtime.ts` | 非敏感运行时状态持久化（默认 runtime、last model、自定义 Provider 元数据） |
| `src/quota.ts` | Provider 远程额度查询（`agentx quota`） |
| `src/doctor.ts` / `src/ui.ts` | 诊断 / 交互式启动器（含自定义 Provider 的 Add/Remove 流程） |

> 注：相比 agentx.md 中建议的 `src/commands/`、`src/proxy/`、`src/runtime/` 目录结构，实际实现是扁平化的 `src/*.ts`（server.ts 取代了 proxy/anthropic/responses/chat-completions/auth 分层，转换逻辑集中在 `src/convert/`，按上游协议而非方向拆分）。
