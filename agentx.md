# 项目：agentx

请实现一个生产可用的 npm CLI 工具 **`agentx`**。

项目的核心目标是：

> 让 Claude Code 无需用户手动配置环境变量，即可通过本地 Adapter 使用 OpenCode 提供的模型。

最终用户只需要：

```bash
npx agentx claude
```

即可自动：

1. 检查 OpenCode API Key
2. 启动本地 Anthropic-compatible Adapter
3. 自动选择可用端口
4. 自动生成本地临时认证 Token
5. 为 Claude Code 注入所需环境变量
6. 启动 Claude Code
7. 将 Claude Code 的 Anthropic API 请求转换为 OpenCode API
8. 将 OpenCode 的响应转换回 Anthropic API 格式
9. 将 Claude Code 的 stdin/stdout/stderr 原样连接到当前终端
10. Claude Code 退出后自动关闭 Adapter
11. 不修改用户的 `.bashrc`、`.zshrc`、Windows 环境变量或其他永久配置

---

# 一、产品定位

项目名称：

```text
agentx
```

npm 包：

```text
agentx
```

CLI：

```text
agentx
```

项目不是 OpenCode 的 fork，也不是 Claude Code 的 fork。

它是一个：

```text
Local API Adapter
+
Process Launcher
+
Provider Router
```

架构：

```text
                    Claude Code
                         │
                         │ Anthropic Messages API
                         ▼
                ┌──────────────────┐
                │ agentx │
                │                  │
                │ Local Proxy      │
                │ Process Manager  │
                │ Model Router     │
                └────────┬─────────┘
                         │
               OpenCode API
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
      GPT-5.6 Luna   DeepSeek V4 Pro  DeepSeek V4 Flash
          │              │              │
          └──────────────┴──────────────┘
                         │
                         ▼
                    OpenCode
```

---

# 二、核心用户体验

## 2.1 一键启动 Claude Code

最重要的命令：

```bash
npx agentx claude
```

这个命令必须完成全部操作。

用户不需要：

```bash
export ANTHROPIC_BASE_URL=...
export ANTHROPIC_API_KEY=...
export ANTHROPIC_MODEL=...
```

也不需要：

```bash
npm run proxy
```

然后再：

```bash
claude
```

所有事情由 Adapter 自动完成。

---

# 三、CLI 命令设计

实现以下命令：

```text
agentx
├── claude
├── proxy
├── exec
├── doctor
└── version
```

## 3.1 `claude`

```bash
npx agentx claude
```

行为：

```text
启动 Adapter
    ↓
等待 Adapter health check
    ↓
构造 Claude Code 环境变量
    ↓
启动 Claude Code
    ↓
连接 stdin/stdout/stderr
    ↓
Claude Code 退出
    ↓
关闭 Adapter
    ↓
返回 Claude Code exit code
```

---

## 3.2 `proxy`

```bash
npx agentx proxy
```

只启动 Adapter，不启动 Claude Code。

输出类似：

```text
AgentX

✓ Provider: OpenCode
✓ Model: gpt-5.6-luna
✓ Local server: http://127.0.0.1:8787

Claude Code environment:

ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=<local-token>
ANTHROPIC_MODEL=gpt-5.6-luna

Press Ctrl+C to stop.
```

---

## 3.3 `exec`

支持：

```bash
npx agentx exec -- claude
```

也支持：

```bash
npx agentx exec -- opencode
```

以及：

```bash
npx agentx exec -- <任意命令>
```

行为：

```text
启动 Adapter
    ↓
注入环境变量
    ↓
执行用户命令
    ↓
转发 stdin/stdout/stderr
    ↓
命令退出
    ↓
关闭 Adapter
    ↓
返回原命令 exit code
```

---

## 3.4 `doctor`

```bash
npx agentx doctor
```

检查：

- Node.js 版本
- npm/npx
- OpenCode API Key
- OpenCode API connectivity
- `/v1/models`
- GPT-5.6 Luna 是否可用
- DeepSeek V4 Pro 是否可用
- DeepSeek V4 Flash 是否可用
- 本地端口
- Claude Code 是否安装
- Claude Code executable 是否能够找到
- 当前 OS
- 当前 shell
- WSL 环境
- Adapter 配置

输出：

```text
AgentX Doctor

Environment
✓ Node.js        v24.x
✓ Platform       linux
✓ Architecture   x64

OpenCode
✓ API key        found
✓ API reachable
✓ /v1/models     reachable

Models
✓ gpt-5.6-luna
✓ deepseek-v4-pro
✓ deepseek-v4-flash

Claude Code
✓ installed
✓ executable found

Adapter
✓ port available

Status: Ready
```

如果失败，要给出明确的修复建议。

---

# 四、配置

不要要求用户修改 shell profile。

支持以下环境变量：

```text
OPENCODE_API_KEY
AGENTX_PORT
AGENTX_HOST
AGENTX_MODEL
AGENTX_LOG_LEVEL
```

默认：

```text
AGENTX_HOST=127.0.0.1
AGENTX_PORT=8787
AGENTX_MODEL=gpt-5.6-luna
```

如果默认端口被占用：

```text
8787
8788
8789
...
```

自动寻找可用端口。

---

# 五、API Key 设计

真实的 OpenCode API Key：

```text
OPENCODE_API_KEY
```

只应该由 Adapter 使用。

不要直接把真实 OpenCode API Key 注入 Claude Code。

Claude Code 使用一个 Adapter 启动时随机生成的本地 Token：

```text
ANTHROPIC_API_KEY=<random-local-token>
```

Adapter：

```text
Claude Code
    ↓
Authorization: Bearer <local-token>
    ↓
Adapter 验证
    ↓
Authorization: Bearer <real-opencode-key>
    ↓
OpenCode
```

本地 Token 每次启动 Adapter 都应该重新生成。

不要持久化。

---

# 六、Claude Code 环境变量

Adapter 启动 Claude Code 时自动注入：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
ANTHROPIC_API_KEY=<local-token>
ANTHROPIC_MODEL=<selected-model>
```

不要修改：

```text
~/.bashrc
~/.zshrc
/etc/environment
Windows Environment Variables
```

只通过 child process environment 注入。

---

# 七、API Adapter

Adapter 必须提供：

```http
POST /v1/messages
```

以及：

```http
GET /health
```

可选：

```http
GET /v1/models
```

---

# 八、Anthropic → OpenCode

Claude Code 使用 Anthropic Messages API。

Adapter 接收类似：

```json
{
  "model": "gpt-5.6-luna",
  "max_tokens": 4096,
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}
```

需要转换成 OpenCode GPT-5.6 Luna 所需的 Responses API：

```http
POST https://opencode.ai/zen/go/v1/responses
```

例如：

```json
{
  "model": "gpt-5.6-luna",
  "input": [
    {
      "role": "user",
      "content": "Hello"
    }
  ]
}
```

system：

```text
Anthropic system
        ↓
Responses API instructions
```

max_tokens：

```text
Anthropic max_tokens
        ↓
Responses max_output_tokens
```

---

# 九、模型 Endpoint Router

Adapter 不允许假设所有 OpenCode 模型都使用同一个 endpoint。

模型 Provider 配置应该抽象为：

```ts
interface ModelProvider {
  model: string;
  protocol:
    | "responses"
    | "chat-completions"
    | "anthropic";
  endpoint: string;
}
```

至少支持：

```text
gpt-5.6-luna
    → /v1/responses

deepseek-v4-pro
    → /v1/chat/completions

deepseek-v4-flash
    → /v1/chat/completions
```

不要把 endpoint 判断逻辑散落在代码中。

统一放在：

```text
src/providers/
```

---

# 十、响应转换

OpenCode Responses：

```json
{
  "id": "...",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "role": "assistant",
      "content": [
        {
          "type": "output_text",
          "text": "OK"
        }
      ]
    }
  ],
  "usage": {
    "input_tokens": 9,
    "output_tokens": 5
  }
}
```

转换为 Anthropic：

```json
{
  "id": "...",
  "type": "message",
  "role": "assistant",
  "model": "gpt-5.6-luna",
  "content": [
    {
      "type": "text",
      "text": "OK"
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 9,
    "output_tokens": 5
  }
}
```

---

# 十一、Streaming

必须支持：

```json
{
  "stream": true
}
```

Claude Code 是高度依赖 streaming 的，因此不能只实现非流式 API。

Adapter 必须：

```text
Claude Code
    ↓
Anthropic SSE
    ↓
Adapter
    ↓
OpenCode Responses Streaming
    ↓
Adapter
    ↓
Anthropic SSE
    ↓
Claude Code
```

需要正确处理至少：

```text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
```

以及对应的 text delta。

不要把 OpenCode 的 SSE 原样转发给 Claude Code。

必须进行协议转换。

---

# 十二、Tool Calling

必须支持 Claude Code 的核心工具调用。

Anthropic：

```text
tool_use
```

转换为 OpenAI/OpenCode：

```text
function_call
```

然后：

```text
Claude Code
    ↓
tool_use
    ↓
用户环境执行 tool
    ↓
tool_result
    ↓
Adapter
    ↓
function_call_output
    ↓
OpenCode
```

需要支持：

- tool name
- tool description
- input_schema
- tool_use id
- tool_result
- parallel tool calls

工具调用不能在 Adapter 内部执行。

Adapter 只负责协议转换。

---

# 十三、System Prompt

必须正确处理：

```text
Anthropic system
```

支持：

```text
string
```

以及结构化 system content。

对于 GPT-5.6 Luna Responses：

```text
system
    ↓
instructions
```

---

# 十四、上下文

Adapter 必须保持 Claude Code 的完整消息上下文。

不要自己做对话历史持久化。

Claude Code 每次请求都会携带上下文，因此 Adapter 应该：

```text
request
↓
转换
↓
upstream
↓
response
```

保持 stateless。

---

# 十五、Process Manager

`claude` / `exec` 模式需要实现可靠的进程管理。

必须：

- forward stdin
- forward stdout
- forward stderr
- preserve exit code
- handle SIGINT
- handle SIGTERM
- cleanup child process
- cleanup adapter
- avoid orphan processes

例如：

```text
Ctrl+C
 ↓
Claude Code SIGINT
 ↓
等待退出
 ↓
Adapter shutdown
 ↓
process exit
```

不能留下后台 Adapter。

---

# 十六、跨平台

至少支持：

```text
Windows
Linux
WSL
macOS
```

重点优化：

```text
Windows native
WSL
Linux
```

Claude Code executable discovery 必须考虑：

```text
claude
claude.cmd
claude.exe
```

不要假设所有平台都是 POSIX。

---

# 十七、WSL

在 WSL 中：

```bash
npx agentx claude
```

应该直接：

```text
WSL
 ↓
Node.js
 ↓
Local Adapter
 ↓
Claude Code
```

不依赖 Windows Node/npm。

如果检测到：

```text
WSL_INTEROP
```

或者 `/proc/version` 中存在 Microsoft/WSL 特征，应正确显示：

```text
Platform: WSL
```

不要自动读取 Windows 的 npm/Node 环境。

---

# 十八、日志

默认日志应该简洁：

```text
✓ OpenCode connected
✓ Adapter started on 127.0.0.1:8787
✓ Model: gpt-5.6-luna
✓ Starting Claude Code...
```

不要输出：

- API Key
- Authorization header
- 用户 prompt
- tool 参数中的敏感数据

支持：

```bash
AGENTX_LOG_LEVEL=debug
```

debug 模式可以输出：

```text
[adapter] POST /v1/messages
[provider] POST /v1/responses
[provider] status=200
```

但仍然不能泄露 Key。

---

# 十九、模型选择

支持：

```bash
npx agentx claude --model gpt-5.6-luna
```

以及：

```bash
npx agentx claude --model deepseek-v4-flash
```

默认：

```text
gpt-5.6-luna
```

未来支持：

```bash
npx agentx claude --model auto
```

其中：

```text
auto
 ├── complex → gpt-5.6-luna
 ├── normal  → deepseek-v4-pro
 └── simple  → deepseek-v4-flash
```

但是第一阶段不要实现复杂自动路由。

先实现：

```text
explicit model selection
```

---

# 二十、配置优先级

模型：

```text
CLI argument
    >
AGENTX_MODEL
    >
default
```

API Key：

```text
CLI argument
    >
OPENCODE_API_KEY
    >
interactive prompt
```

端口：

```text
CLI argument
    >
AGENTX_PORT
    >
8787
    >
automatic fallback
```

---

# 二十一、CLI 参数

实现：

```bash
agentx claude [options]

Options:
  --model <model>
  --port <port>
  --host <host>
  --api-key <key>
  --verbose
```

Proxy：

```bash
agentx proxy [options]
```

Exec：

```bash
agentx exec [options] -- <command>
```

Doctor：

```bash
agentx doctor
```

---

# 二十二、项目结构

建议：

```text
agentx/
│
├── package.json
├── package-lock.json
├── tsconfig.json
├── README.md
├── LICENSE
│
├── src/
│   ├── cli.ts
│   │
│   ├── commands/
│   │   ├── claude.ts
│   │   ├── proxy.ts
│   │   ├── exec.ts
│   │   └── doctor.ts
│   │
│   ├── proxy/
│   │   ├── server.ts
│   │   ├── auth.ts
│   │   ├── anthropic.ts
│   │   ├── responses.ts
│   │   ├── chat-completions.ts
│   │   └── streaming.ts
│   │
│   ├── providers/
│   │   ├── types.ts
│   │   └── opencode.ts
│   │
│   ├── runtime/
│   │   ├── process.ts
│   │   ├── port.ts
│   │   ├── environment.ts
│   │   └── platform.ts
│   │
│   ├── config/
│   │   └── config.ts
│   │
│   └── utils/
│       ├── logger.ts
│       └── errors.ts
│
└── test/
    ├── anthropic.test.ts
    ├── responses.test.ts
    ├── streaming.test.ts
    ├── tools.test.ts
    └── cli.test.ts
```

可以根据实际实现调整，但必须保持职责分离。

---

# 二十三、技术要求

推荐：

```text
Node.js >= 20
TypeScript
ESM
```

HTTP：

```text
Node.js native fetch
```

不要为了简单 HTTP 请求引入重量级 SDK。

CLI 可以使用轻量 CLI library，但如果原生实现足够简单，也可以不依赖 CLI framework。

目标：

```text
npx agentx
```

首次运行即可使用。

---

# 二十四、安全要求

绝对禁止：

```text
硬编码 API Key
日志输出 API Key
把真实 API Key 注入 Claude Code
永久修改 shell profile
永久修改 Windows Environment Variables
```

Adapter 默认只监听：

```text
127.0.0.1
```

不要默认：

```text
0.0.0.0
```

如果用户显式指定：

```bash
--host 0.0.0.0
```

需要明确提示：

```text
Warning: Adapter will be accessible from the network.
```

---

# 二十五、错误处理

如果没有 API Key：

```text
OpenCode API key not found.

Set:
  OPENCODE_API_KEY=...

or run:
  agentx claude --api-key <key>
```

如果 OpenCode 不可用：

```text
Unable to connect to OpenCode.

Run:
  agentx doctor
```

如果模型不存在：

```text
Model "xxx" is not available.

Available models:
...
```

如果 Claude Code 找不到：

```text
Claude Code was not found.

Install Claude Code first, then run:
  npx agentx claude
```

---

# 二十六、README

README 必须首先展示最简单的用法：

```bash
npx agentx claude
```

然后说明：

```text
Claude Code
     ↓
agentx
     ↓
OpenCode
```

提供：

1. Quick Start
2. Installation
3. API Key
4. Claude Code
5. Proxy Mode
6. Exec Mode
7. Model Selection
8. Doctor
9. WSL
10. Windows
11. Architecture
12. Security
13. Development
14. Troubleshooting

---

# 二十七、测试策略

必须实现单元测试。

至少测试：

### Basic request

```text
Anthropic request
→ Responses request
```

### Basic response

```text
Responses response
→ Anthropic response
```

### System

```text
system
→ instructions
```

### Tools

```text
Anthropic tools
→ function tools
```

### Tool result

```text
tool_result
→ function_call_output
```

### Streaming

测试：

```text
Responses SSE
→ Anthropic SSE
```

### Error

测试：

```text
401
403
404
429
500
```

---

# 二十八、真实 API 验证

开发完成后使用真实 OpenCode API 验证：

```bash
curl https://opencode.ai/zen/go/v1/models \
  -H "Authorization: Bearer $OPENCODE_API_KEY"
```

确认：

```text
gpt-5.6-luna
```

存在。

然后直接验证：

```bash
curl https://opencode.ai/zen/go/v1/responses \
  -H "Authorization: Bearer $OPENCODE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "input": "只回复 OK"
  }'
```

然后验证：

```text
Claude Code
↓
agentx
↓
OpenCode
↓
GPT-5.6 Luna
```

---

# 二十九、开发阶段

不要一开始实现全部复杂功能。

严格按照：

## Phase 1

实现：

```text
CLI
+
proxy
+
claude launcher
+
API key
+
/v1/messages
+
Responses API
+
non-streaming
```

完成：

```bash
npx agentx claude
```

可以运行 Claude Code。

---

## Phase 2

实现：

```text
streaming
```

确保 Claude Code 的正常交互体验。

---

## Phase 3

实现：

```text
tools
tool_use
tool_result
parallel calls
```

确保 Claude Code 可以正常执行 shell、文件操作等工具。

---

## Phase 4

实现：

```text
DeepSeek V4 Pro
DeepSeek V4 Flash
```

支持：

```bash
npx agentx claude --model deepseek-v4-flash
```

---

## Phase 5

实现：

```bash
npx agentx claude --model auto
```

建立 Model Router。

---

# 三十、最终目标

最终用户体验必须做到：

```bash
npx agentx claude
```

然后用户看到：

```text
AgentX

✓ OpenCode connected
✓ Model: gpt-5.6-luna
✓ Adapter: 127.0.0.1:8787
✓ Claude Code started

>
```

用户完全不需要知道：

```text
ANTHROPIC_BASE_URL
ANTHROPIC_API_KEY
OpenAI Responses API
Anthropic Messages API
OpenCode endpoint
Adapter port
Proxy lifecycle
```

这些全部由 `agentx` 管理。

最终架构：

```text
                         User
                          │
                          │
             npx agentx claude
                          │
                          ▼
               ┌────────────────────┐
               │   CLI Launcher     │
               └─────────┬──────────┘
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
       Process Manager         Local Adapter
              │                     │
              │              Anthropic API
              │                     │
              ▼                     ▼
        Claude Code          Protocol Router
                                    │
                       ┌────────────┼────────────┐
                       │            │            │
                       ▼            ▼            ▼
                    Luna       DeepSeek Pro  DeepSeek Flash
                       │            │            │
                       └────────────┴────────────┘
                                    │
                                    ▼
                              OpenCode
```

请直接按照以上规格实现项目。

实现过程中不要为了“未来可能需要”过度设计；优先保证 Phase 1 → Phase 2 → Phase 3 每一步都可运行、可测试、可独立验证。

尤其注意：**Claude Code 的真实 API 行为必须通过实际请求验证，不要假设 Anthropic SSE、tool_use、Responses API 的字段完全一致。对于协议转换，应建立独立的类型和转换层，并通过测试覆盖。**
