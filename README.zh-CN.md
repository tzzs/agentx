# agentx

[![CI](https://github.com/tzzs/agentx/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/agentx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tzzs%2fagentx)](https://www.npmjs.com/package/@tzzs/agentx)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

通过本地 API 适配器，让 Claude Code 或 Codex 使用 OpenCode 提供的模型。Claude Code 使用本地 Anthropic 兼容 Messages API，Codex 使用本地 OpenAI 兼容 Responses API。适配器负责将请求转换为上游 API 请求，为子进程注入临时认证信息，并在子进程退出后清理本地服务。

> **项目状态：** 当前为早期版本。项目包含协议转换层和自动化测试，但在生产使用前仍应使用自己的 OpenCode 账号验证真实上游 API 的兼容性。

## 快速开始

依赖环境：

- Node.js 20 或更高版本
- OpenCode API Key
- 已安装且能在 `PATH` 中找到 `claude` 的 Claude Code
- 使用 Codex 时，需要已安装且能在 `PATH` 中找到 `codex` 的 Codex

```bash
export AGENTX_OPENCODE_API_KEY="your-api-key"
npx agentx claude
```

该命令会启动仅监听本机回环地址的适配器，等待服务就绪，然后使用临时 `ANTHROPIC_*` 环境变量启动 Claude Code，转发终端输入输出，并在 Claude Code 退出后关闭适配器。

真实的 OpenCode Key 不会传给 Claude Code。Claude Code 每次只会收到一个随机生成的本地临时 Token。

也可以查看凭据的配置指引与状态：

```bash
agentx auth login --provider deepseek
agentx auth status --provider deepseek
agentx auth logout --provider deepseek
```

对于上游已公开额度接口的 Provider，可以查询额度：

```bash
agentx usage --provider deepseek
agentx usage --provider openrouter
```

不带 `--provider` 时，`agentx usage` 会打印适配器处理的每个请求累计的 Token
用量统计（见 [Token 用量统计](#token-用量统计)）：

```bash
agentx usage
agentx usage --period today
```

OpenCode 当前会返回明确的不支持结果，因为它没有公开、文档化的额度接口。

同时支持通过 OpenAI 兼容环境启动 Pi Agent：

```bash
agentx pi --provider openrouter --model anthropic/claude-sonnet-4
```

## 凭据与 Provider Profile

凭据完全通过环境变量提供：AgentX 专用的变量统一带 `AGENTX_` 前缀（如 `AGENTX_OPENCODE_API_KEY`），避免与用户为其他工具设置的同名变量冲突；运行时解析后按原始 Key 注入上游请求，前缀只存在于变量命名空间中。如果已经设置了不带前缀的旧变量（如 `OPENCODE_API_KEY`），也会被直接使用。凭据查找优先级为：`--api-key`、`AGENTX_<PROVIDER>_API_KEY`、旧的 `<PROVIDER>_API_KEY`、交互式输入。交互式输入 Key 后，AgentX 会询问（默认是）是否将 `AGENTX_<PROVIDER>_API_KEY` 保存到你的 shell profile；选择否则该 Key 仅当前会话有效，并打印手动持久化的指引。

非敏感的 Provider Profile 和模型映射保存在 `~/.config/agentx/profiles.json`，API Key 不会写入该文件或任何由 AgentX 管理的存储；仅在用户明确同意后追加到 shell profile。

## Provider 架构

适配器分为三层：面向 Claude Code/Codex 的客户端层、负责 Anthropic Messages 与 OpenAI Responses/Chat Completions 的协议适配层，以及负责上游平台接入的 Provider 层。

当前支持的上游 Provider：

| Provider | 凭据（推荐） | 凭据（兼容） | 示例模型 |
| --- | --- | --- | --- |
| OpenCode | `AGENTX_OPENCODE_API_KEY` | `OPENCODE_API_KEY` | `gpt-5.6-luna` |
| DeepSeek | `AGENTX_DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| OpenRouter | `AGENTX_OPENROUTER_API_KEY` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4` |

当模型名可能重复时，可以显式选择 Provider：

```bash
agentx claude --provider deepseek --model deepseek-v4-pro
agentx codex --provider openrouter --model anthropic/claude-sonnet-4
```

也可以使用环境变量 `AGENTX_PROVIDER`。Provider 凭据只由 Adapter 使用，不会注入客户端进程。

对于 Claude Code，本地 Token 会注入为 `ANTHROPIC_AUTH_TOKEN`，而不是 `ANTHROPIC_API_KEY`。这与 DeepSeek 等 Provider 的接入方式一致，可以避免 Claude Code 弹出自定义 API Key 确认页面；上游真实 Key 始终只保留在 Adapter 中。

Claude Code 的所有模型档位（主模型、opus/sonnet/haiku 别名、子代理）都会固定为所选模型——用户的选择对所有流量生效，包括 Claude Code 通过 haiku 档位发起的小型后台请求（权限检查、主题检测、摘要等）。可选地，通过 `--background-model <id>`（或环境变量 `AGENTX_BACKGROUND_MODEL`）可以仅将这一后台通道路由到同一 Provider 下的其他模型——当主模型是重量级推理模型、其非流式辅助调用超过客户端超时时间时会很实用。凡是指定了目标 Provider 实际提供的模型的请求都会按原样转发；未知模型 id 则回退到配置的模型。

如果在交互式终端启动 `claude`、`codex` 或 `pi` 时没有指定 `--provider`/`--model`，且没有设置 `AGENTX_PROVIDER`/`AGENTX_MODEL`，适配器会显示交互式运行时启动器：先选择 Provider，再选择模型，最后选择「立即启动」或「设为默认并启动」。模型选择支持搜索：输入文字即可按模型 id 过滤列表，↑/↓ 选择、Enter 确认。切换 Provider 会自动为该 Provider 解析模型，并记住每个 Provider 最近使用的模型。临时切换不会覆盖已保存的默认运行时，除非选择「设为默认并启动」。非交互场景会自动使用目录中的默认模型。

## Codex 支持

使用本地 OpenAI 兼容 Responses API 启动 Codex：

```bash
npx agentx codex
npx agentx codex --model gpt-5.6-luna
```

启动器通过 `-c` 参数定义一个内联的 `agentx` 模型 Provider，指向 `http://127.0.0.1:<port>/v1`，其 Bearer Token 是以 `OPENAI_API_KEY` 注入的临时本地 Token。启动时还会生成一份模型目录（`~/.config/agentx/codex-models.json`，经 `model_catalog_json` 传入），让目录中的模型——包括你在启动器中输入的自定义 OpenRouter 模型 id——以真实元数据加载，而不是触发 Codex 的 fallback 元数据警告：上下文窗口与输出上限对所有 Provider 生效，在可用时取自公开注册表 models.dev，models.dev 缺失的模型回退到 OpenRouter 公开目录，否则使用保守默认值。新版 Codex 已不再读取那些环境变量，该方式可以正常工作，并完全绕过 Codex 的登录页——无需 ChatGPT 登录或 `~/.codex/auth.json`，也不会修改你已有的 `~/.codex/config.toml`。Codex 现在同时支持 Responses 和 Chat Completions 模型：Responses 模型直接转发，Chat Completions 模型在本地 Responses 边界进行协议转换。因此 Provider 目录中的模型都可以供 Claude Code 和 Codex 使用。

## 安装

无需安装，直接使用：

```bash
npx agentx claude
```

全局安装：

```bash
npm install --global @tzzs/agentx
agentx claude
```

## 命令

### `claude`

同时启动适配器和 Claude Code：

```bash
agentx claude
agentx claude --model deepseek-v4-flash
agentx claude --port 9000 --host 127.0.0.1
```

### `codex`

同时启动适配器和 Codex。Codex 会通过 `-c` 参数收到一个指向本地适配器的内联模型 Provider：

```bash
agentx codex
```

### `proxy`

只启动本地适配器，按 `Ctrl+C` 停止：

```bash
agentx proxy
```

本地 API 地址为 `http://127.0.0.1:<port>`，提供 `GET /health`、`GET /v1/models`、`POST /v1/messages`、`POST /v1/responses`，以及 [Token 用量统计](#token-用量统计) 中说明的只读用量端点。

### `exec`

使用临时 Anthropic 环境变量执行任意命令：

```bash
agentx exec -- claude
agentx exec -- opencode
agentx exec -- my-command --argument
```

在当前平台支持的范围内，命令的 stdin、stdout、stderr、退出码和终止信号都会被转发。

### `doctor`

检查本地环境和配置：

```bash
agentx doctor
```

报告包含 Node.js、平台/WSL 状态、CPU 架构、API Key 是否存在、支持的模型，以及 Claude Code 是否可被发现。

### `version`

```bash
agentx version
```

### `auth`

查看凭据的配置指引与状态（凭据保存在环境变量中，AgentX 自身不存储任何密钥）：

```bash
agentx auth login --provider deepseek    # 打印配置指引
agentx auth status --provider deepseek   # 查看当前来源与状态
agentx auth logout --provider deepseek   # 提示如何从 shell profile 移除
```

### `usage`

打印适配器服务的每个请求累计的 Token 用量统计：

```bash
agentx usage                 # 全部时间
agentx usage --period today  # today / week / month / all
```

报告按 Provider 和模型分组显示 Token 数，包含输入/输出/总量，以及基于
Provider 定价估算的成本。统计按适配器运行保存；`--period` 可按时间范围过滤。

带 `--provider` 时，该命令改为查询已公开额度接口的 Provider 额度：

```bash
agentx usage --provider deepseek
agentx usage --provider openrouter
```

OpenCode 当前会返回明确的不支持结果，因为它没有公开、文档化的额度接口。

### `pi`

通过 OpenAI 兼容本地环境启动 Pi Agent：

```bash
agentx pi --provider openrouter --model anthropic/claude-sonnet-4
```

## 配置

CLI 参数优先于环境变量。默认模型为 `gpt-5.6-luna`。

| CLI 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--api-key <key>` | `AGENTX_OPENCODE_API_KEY`（兼容 `OPENCODE_API_KEY`） | 无 | OpenCode 凭据 |
| `--host <host>` | `AGENTX_HOST` | `127.0.0.1` | 本地监听地址 |
| `--port <port>` | `AGENTX_PORT` | `8787` | 首选本地端口 |
| `--model <model>` | `AGENTX_MODEL` | `gpt-5.6-luna` | 模型名或 `auto` |
| `--provider <id>` | `AGENTX_PROVIDER` | 无 | 上游 Provider（`opencode`、`deepseek`、`openrouter`） |
| `--verbose` | `AGENTX_LOG_LEVEL` | `info` | 预留的详细日志选项 |
| | `AGENTX_USAGE_DIR` | `~/.config/agentx` | Token 用量统计存储目录 |

如果首选端口已被占用，适配器会依次尝试后续端口。非回环监听必须显式指定，并且只应在可信网络中使用：

```bash
agentx proxy --host 0.0.0.0
```

## 模型和路由

启动时从 `https://opencode.ai/zen/go/v1/models` 拉取 OpenCode 模型目录。当无法访问该接口时，使用内置的回退目录：

| 模型 | 上游协议 |
| --- | --- |
| `gpt-5.6-luna` | Responses API |
| `deepseek-v4-pro` | Chat Completions API |
| `deepseek-v4-flash` | Chat Completions API |
| `minimax-m3`、`minimax-m2.7`、`minimax-m2.5` | Chat Completions API |
| `kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`、`kimi-k2.5` | Chat Completions API |
| `glm-5.3`、`glm-5.2`、`glm-5.1`、`glm-5` | Chat Completions API |
| `mimo-v2.5-pro`、`mimo-v2.5`、`hy3` | Chat Completions API |

接口返回的模型使用 Responses API（`gpt-5.6-luna`）或 Chat Completions API（其余模型）。`--model auto` 仍然在一小部分已知模型之间路由，本地 `/v1/models` 端点始终反映当前目录。

OpenRouter Provider 接受任意模型 id（默认使用 `OPENROUTER_MODEL` 或 `openai/gpt-4o-mini`）。交互式启动器的模型选择列表中包含 "Enter a custom model id…" 选项，可以直接输入任意 OpenRouter 模型 id（例如 `anthropic/claude-sonnet-4.5`）。

显式选择模型：

```bash
agentx claude --model gpt-5.6-luna
```

使用 `--model auto` 时，短请求使用 `deepseek-v4-flash`，较大请求使用 `deepseek-v4-pro`，包含工具或较大上下文的请求使用 `gpt-5.6-luna`。这是一个简单的初版路由器，不是基于基准测试的模型推荐系统。

## API 转换

适配器不会持久化对话历史。Claude Code 会在每次请求中携带完整对话；唯一的本地持久化是聚合后的 Token 用量统计（见 [Token 用量统计](#token-用量统计)）。

当前支持的转换包括：

- Anthropic `system` 内容转换为 Responses `instructions` 或 Chat Completions system 消息
- `max_tokens` 转换为上游输出 Token 限制
- Anthropic 文本消息与响应文本
- Anthropic 流式事件与上游 SSE 事件转换
- Anthropic `tools`、`tool_use`、`tool_result` 与 function tool、function call output 转换
- Responses 和 Chat Completions usage 字段转换为 Anthropic usage 字段

适配器只负责工具协议转换，不会执行工具，也不会持久化 prompt、工具参数或对话状态。

## Token 用量统计

每个成功请求都会自动测量并归一化为 Provider 无关的 `TokenUsage` 记录。
各 Provider 通过自己的用量适配器（`src/providers/usage/`）把 Provider 特有的
字段映射成通用格式；核心运行时只感知 `TokenUsage`。

用量持久化到本地 SQLite 数据库（使用 Node 内置的 `node:sqlite`），路径为
`~/.config/agentx/usage.db`；当 `node:sqlite` 不可用时回退为 JSON 文件。
记录中包含 Provider、模型、输入/输出/总 Token、缓存与推理 Token、会话 ID
和时间戳。

### 流式响应

对于流式响应，当 Provider 在最后一个数据块中返回 usage 时，适配器会捕获它。
如果 Provider 没有返回 usage，适配器会累计增量并把记录标记为 `estimated`。

### 查询 API

适配器提供只读的用量端点（无需认证）：

| 端点 | 说明 |
| --- | --- |
| `GET /usage/session?id=<session>` | 单个会话的输入/输出/总 Token |
| `GET /usage/providers?period=...` | 按 Provider 统计的 Token 与请求数 |
| `GET /usage/stats?period=...` | 按时间范围统计的总量 |

`period` 接受 `today`、`week`、`month` 或 `all`。不传 `period` 时统计全部记录。
会话端点也支持路径形式 `GET /usage/session/<id>`。

### 成本估算

定价层（`src/usage/pricing/`）把 Token 数量转换为每个 Provider 的估算成本。
用量收集与成本计算相互独立；CLI 报告仅用定价层做展示。

### 存储与数据

- 统计保存在 `~/.config/agentx/usage.db`（或 `usage.json` 回退）。
- `AGENTX_USAGE_DIR` 可覆盖存储目录。
- 只保存 Token 数量和元数据——绝不保存 prompt、工具参数或对话内容。

## 安全与隐私

- 上游 API Key 只从 CLI 或环境变量读取，并只发送给 OpenCode。
- Claude Code 每次只收到适配器进程生成的随机本地 Bearer Token，该 Token 不会持久化。
- 默认监听 `127.0.0.1`，不会修改 shell profile 或永久操作系统环境变量。
- `/usage/*` 查询端点无需认证；它们只暴露聚合后的 Token 数量，在本地回环地址访问是安全的，但适配器绑定到非回环接口时请勿暴露这些端点。
- 日志不应包含 API Key、Authorization Header、用户 prompt 或敏感工具参数。
- `--host 0.0.0.0` 会主动暴露网络服务，请配置适当的网络访问控制。

## 平台支持

启动器面向 Linux、macOS、Windows 和 WSL 设计。WSL 通过 `WSL_INTEROP` 检测，并使用当前 WSL 中的 Node.js，不依赖 Windows Node.js 安装。Claude Code 会按照平台的常规可执行文件规则发现，包括 Windows shell 执行方式。

## 开发

```bash
git clone https://github.com/tzzs/agentx.git
cd agentx
npm ci
npm test
npm run build
```

项目使用 TypeScript、Node.js 原生 `fetch`、Node.js ESM 和内置 `node:test` 测试运行器。测试会先编译到 `dist/test`，再执行编译后的测试。

测试覆盖请求/响应转换、system instructions、流式事件、工具调用、模型路由、Chat Completions 转换，以及 Token 用量适配器、存储、定价和用量查询 API。测试不需要 API Key，也不依赖网络。

## CI 与发布

GitHub Actions 会在每次 push 和针对 `main` 的 Pull Request 中运行构建、测试和 npm 包内容检查。`.github/workflows/release-please.yml` 会根据 Conventional Commits 创建版本发布 PR。发布配置位于 `.github/workflows/publish.yml`：

1. 在 GitHub 的 `npm` environment 中添加 `NPM_TOKEN` Secret。
2. 推送匹配 `v*.*.*` 的版本标签，或手动运行 **Publish package** 工作流。
3. 工作流会运行完整测试，并使用 provenance 发布到 `https://registry.npmjs.org`。

## 故障排查

**`OpenCode API key not found`**

设置 `AGENTX_OPENCODE_API_KEY`（已设置的旧变量 `OPENCODE_API_KEY` 依然有效），或传入 `--api-key <key>`。本地服务启动前必须提供 Key。

**找不到 Claude Code**

安装 Claude Code，确保在同一个 shell 的 `PATH` 中可以执行 `claude`，然后运行 `agentx doctor`。

**`Codex not found: the "codex" command is not installed or not on PATH`**

当客户端可执行文件缺失时，AgentX 会说明问题并给出推荐的安装命令（例如 `npm install -g @openai/codex`）。在交互式终端中还会询问是否立即执行该命令，并在确认安装成功后自动重新启动客户端。也可以选择跳过、手动安装，之后再次运行相同的 `agentx <client>` 命令。

**端口被占用**

适配器会从配置端口开始自动尝试后续端口。也可以使用 `--port` 更换起始端口。

**上游请求失败**

运行 `agentx doctor`，确认 API Key 和模型可用，并检查到 OpenCode API 的网络访问。提交 Issue 时不要粘贴 API Key 或 Authorization Header。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请保持改动聚焦，为协议行为补充或更新测试，运行 `npm test`，并避免提交 Secret、`dist` 和 `node_modules` 等生成目录。

## 许可证

MIT © agentx contributors
