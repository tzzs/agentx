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
  pi/proxy/exec    profiles.ts / usage.ts              │
  auth/doctor/                                    [HTTP 本地服务]
  version                                        127.0.0.1:<port>
```

## 客户端进程启动链路（Process Launcher）

```
cli.ts (claude/codex/pi/exec)
   │
   ├─ ui.ts          selectModel / selectableProviders（交互模型选择）
   ├─ config.ts      loadConfig（CLI 参数 > 环境变量 > 默认值）
   ├─ providers/registry.ts  providerById / apiKeyFor
   ├─ credentials.ts resolveCredential（--api-key > 环境变量 > 系统凭据 > 交互输入）
   ├─ profiles.ts    saveProfile（写入 ~/.config/agentx/profiles.json，不含 Key）
   │
   ├─ server.ts      startAdapter() → 生成本地随机 token，绑定回环端口
   │                     ├─ /health
   │                     ├─ /v1/models
   │                     ├─ /v1/messages   (Anthropic)
   │                     └─ /v1/responses  (OpenAI)
   │
   └─ process.ts     runCommand(executable, ...)  注入环境变量、转发 stdio、清理
        claude  → ANTHROPIC_* (本地 token)
        codex   → OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL
        pi      → OpenAI 兼容环境
```

## 本地 Adapter 协议转换（server.ts + providers/catalog + streaming）

```
Claude Code (Anthropic Messages API)
      │  POST /v1/messages   Bearer <本地随机 token>
      ▼
  server.ts  (校验本地 token，不转发给上游)
      │
      ├─ catalog.ts  selectModel / providerFor（按 model 选路由）
      │
      ├── provider.protocol === "responses"
      │       └─ providers.ts  toResponsesRequest / fromResponsesResponse
      │                            Anthropic ↔ Responses 转换
      │
      └── provider.protocol === "chat-completions"
              └─ catalog.ts  toChatRequest / fromChatResponse（Anthropic ↔ Chat）
              └─ 流式: streaming.ts  pipeResponsesStream / pipeChatStreamToResponses
                                   (Anthropic SSE ↔ OpenAI SSE)
```

## Provider 层（providers/registry.ts + types.ts）

```
                          ┌──────────────────────────────┐
                          │  Provider Registry           │
                          │  providerRegistry[]          │
                          └──────────────┬───────────────┘
                                         │
        ┌────────────────┬───────────────┼────────────────┐
        ▼                ▼               ▼                ▼
   opencode         deepseek       openrouter        (pi 客户端)
  OPENCODE_API_KEY  DEEPSEEK_API_KEY OPENROUTER_API_KEY
  gpt-5.6-luna      deepseek-v4-pro  openai/gpt-4o-mini 默认
  → /v1/responses   deepseek-v4-flash → chat/completions
  +16 chat 模型      → chat/completions
  → /v1/chat/completions
                                         │
                                         ▼
                                  上游 API（OpenCode / DeepSeek / OpenRouter）
```

## 核心设计要点（实际实现）

- **无状态**：Adapter 不持久化对话，Claude Code 每次请求携带全量上下文（server.ts）
- **凭据隔离**：真实 Key 只留在 Adapter 内，客户端只拿到每次启动随机生成的本地 token（`sk-ant-api03-…`）
- **工具调用**：只做协议转换（`tool_use`↔`function_call`、`tool_result`↔`function_call_output`），不在 Adapter 内执行
- **模型路由**：`catalog.ts` 的 `selectModel` 实现 `--model auto` 短请求→flash、大请求→pro、含工具→luna 的初版路由器
- **命令覆盖**：`claude`/`codex`/`pi`/`proxy`/`exec`/`auth`/`usage`/`doctor`/`version`/`help`
- **可选集成**：`keytar` 系统凭据存储；`usage` 查询 DeepSeek/OpenRouter 额度（OpenCode 返回"不支持"）

## 模块 → 职责映射

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 命令分发、参数解析、编排 |
| `src/config.ts` | 配置加载与优先级 |
| `src/server.ts` | HTTP Adapter、认证、路由、端口回退 |
| `src/providers.ts` | Anthropic ↔ Responses 转换 |
| `src/catalog.ts` | Chat Completions 转换 + 模型路由(auto) |
| `src/streaming.ts` | SSE 流式协议转换 |
| `src/providers/registry.ts` + `types.ts` | Provider 目录与模型注册表 |
| `src/process.ts` | 子进程启动/环境注入/stdio 转发/清理 |
| `src/credentials.ts` | 凭据查找（CLI/环境/keytar/交互） |
| `src/profiles.ts` | 非敏感 profile 持久化 |
| `src/doctor.ts` / `src/ui.ts` / `src/usage.ts` | 诊断 / 交互选择 / 额度查询 |

> 注：相比 agentx.md 中建议的 `src/commands/`、`src/proxy/`、`src/runtime/` 目录结构，实际实现是扁平化的 `src/*.ts`（server.ts 取代了 proxy/anthropic/responses/chat-completions/auth 分层，转换逻辑集中在 providers.ts + catalog.ts）。
