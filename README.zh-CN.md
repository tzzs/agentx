# agentx

[![CI](https://github.com/tzzs/agentx/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/agentx/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tanzz%2fagentx)](https://www.npmjs.com/package/@tanzz/agentx)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

通过本地 API 适配器，让 Claude Code、Codex 或 Pi 使用 OpenCode 提供的模型。Claude Code 使用本地 Anthropic 兼容 Messages API，Codex 和 Pi 使用本地 OpenAI 兼容 Responses API。适配器负责将请求转换为上游 API 请求，为子进程注入临时认证信息，并在子进程退出后清理本地服务。

> **项目状态：** 当前为早期版本。项目包含协议转换层和自动化测试，但在生产使用前仍应使用自己的 OpenCode 账号验证真实上游 API 的兼容性。

## 目录

- [快速开始](#快速开始)
- [安装](#安装)
- [命令](#命令)
- [配置](#配置)
- [凭据与 Provider Profile](#凭据与-provider-profile)
- [Provider](#provider)
- [Codex 支持](#codex-支持)
- [模型和路由](#模型和路由)
- [API 转换](#api-转换)
- [Token 用量统计](#token-用量统计)
- [安全与隐私](#安全与隐私)
- [平台支持](#平台支持)
- [开发](#开发)
- [CI 与发布](#ci-与发布)
- [故障排查](#故障排查)
- [参与贡献](#参与贡献)

## 快速开始

依赖环境：

- Node.js 20 或更高版本
- OpenCode API Key
- 已安装且能在 `PATH` 中找到 `claude` 的 Claude Code
- 使用 Codex 时，需要已安装且能在 `PATH` 中找到 `codex` 的 Codex

```bash
npx @tanzz/agentx claude
```

在交互式终端中，首次运行时 AgentX 会提示你输入 OpenCode API Key——该 Key 仅在当前会话有效，绝不会写入磁盘或 shell profile——并引导你完成 Provider / 模型选择（见[运行时配置](#运行时配置)）。随后它会启动仅监听本机回环地址的适配器，等待服务就绪，使用临时 `ANTHROPIC_*` 环境变量启动 Claude Code，转发终端输入输出，并在 Claude Code 退出后关闭适配器。

真实的 OpenCode Key 不会传给 Claude Code。Claude Code 每次只会收到一个随机生成的本地临时 Token。

对于脚本、CI 或任何非交互式 shell，建议提前设置好 Key，而不是依赖交互式提示：

```bash
export AGENTX_OPENCODE_API_KEY="your-api-key"
npx @tanzz/agentx claude
```

`codex`、`pi`、`auth`、`usage`、`quota` 等命令的用法见下方[命令](#命令)一节。

## 安装

无需安装，直接使用——注意 `@tanzz/` 这个 scope：npm 上不带 scope 的 `agentx` 是另一个无关的包，`npx agentx` 不会运行这个工具：

```bash
npx @tanzz/agentx claude
```

全局安装：

```bash
npm install --global @tanzz/agentx
agentx claude
```

## 命令

### `claude`

同时启动适配器和 Claude Code：

```bash
agentx claude
agentx claude --model deepseek-v4-flash
agentx claude --port 9000 --host 127.0.0.1
agentx claude --native   # 跳过适配器，直接以你自己的环境运行真正的 `claude`
```

### `codex`

同时启动适配器和 Codex。Codex 会通过 `-c` 参数收到一个指向本地适配器的内联模型 Provider：

```bash
agentx codex
agentx codex --native   # 跳过适配器，直接以你自己的环境运行真正的 `codex`
```

### `pi`

通过 OpenAI 兼容本地环境启动 Pi Agent：

```bash
agentx pi --provider openrouter --model anthropic/claude-sonnet-4
```

### `exec`

通过本地适配器执行任意命令。和 `claude`/`codex`/`pi` 不同,`exec` 永远不会弹出交互式运行时选择器——它总是按“CLI 参数 → 环境变量 → 最近一次选择 → 内置默认值”非交互式解析,因此可以安全用于脚本和 CI:

```bash
agentx exec -- claude
agentx exec -- opencode
agentx exec -- my-command --argument
```

默认情况下 `exec` 注入 Anthropic 形状的环境变量(`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`),适用于任何接受 Anthropic 兼容端点配置的工具。如果目标工具只认 `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`,加上 `--client-protocol openai`:

```bash
agentx exec --client-protocol openai -- my-openai-compatible-tool
```

在当前平台支持的范围内,命令的 stdin、stdout、stderr、退出码和终止信号都会被转发。

### `proxy`

只启动本地适配器，按 `Ctrl+C` 停止：

```bash
agentx proxy
```

本地 API 地址为 `http://127.0.0.1:<port>`，提供 `GET /health`、`GET /v1/models`、`POST /v1/messages`、`POST /v1/responses`。

### `doctor`

检查本地环境和配置：

```bash
agentx doctor
```

报告包含 Node.js、平台/WSL 状态、CPU 架构、API Key 是否存在、支持的模型，以及 Claude Code 是否可被发现。

### `forget`

清理上游已不再提供的已保存模型 id（例如 OpenRouter 的免费模型被改名为其真实厂商 id 时）：

```bash
agentx forget
```

该命令会刷新 OpenRouter 的实时目录，并把每一个已记住的模型 id 与它比对。交互式终端会打开「已保存模型」管理器，让你勾选要清理的模型；非交互终端则直接打印过期列表：

```bash
agentx forget    # 输出示例：DeepSeek:\n  deepseek-v4-pro  (no longer in the catalog)
```

清理会移除 `runtime.json` 中该 id 的所有痕迹——每个客户端的默认配置、每个 Provider 的最后使用模型、以及最近一次选择——这样被改名的 id 就不会在每次启动时继续被当作「当前」模型提供。

用 `--provider <id> --remove-provider` 可以把一个自定义 Provider 彻底移除（不只是清理某个过期的 model id，见[自定义 Provider](#自定义-provider)）。

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

报告按 Provider 和模型分组显示 Token 数，包含输入/输出/总量。统计按适配器运行保存；`--period` 可按时间范围过滤。

`agentx usage --provider <id>` 是 `agentx quota --provider <id>`（见下文）的过渡期别名，仍然可用，但会打印一行弃用提示。

### `quota`

查询 Provider 的远程额度(账户余额/限额)，仅当上游公开了额度接口时可用：

```bash
agentx quota --provider deepseek
agentx quota --provider openrouter
```

OpenCode 当前会返回明确的不支持结果，因为它没有公开、文档化的额度接口。

### `version`

```bash
agentx version
```

## 配置

客户端运行时按以下顺序解析：

1. 显式 CLI 参数（`--provider`、`--model`、`--api-key`……）
2. 客户端已保存的默认运行时（`runtime.json`）
3. 环境变量（`AGENTX_PROVIDER`、`AGENTX_MODEL`）
4. 交互式启动器选择（没有 CLI/环境变量/已保存模型时）
5. 最近一次选择，最后回退到内置默认值（`opencode` / `gpt-5.6-luna`）

在交互式启动器中完成的每一次选择都会被保存为该客户端的默认值，下次启动直接从它开始。

对于 `claude`/`codex`，`--native`（或在启动器中选择「Launch native (skip AgentX)」）会完全跳过这条解析链——参见[原生启动](#原生启动)。

| CLI 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--api-key <key>` | `AGENTX_OPENCODE_API_KEY`（兼容 `OPENCODE_API_KEY`） | 无 | OpenCode 凭据 |
| `--host <host>` | `AGENTX_HOST` | `127.0.0.1` | 本地监听地址 |
| `--port <port>` | `AGENTX_PORT` | `8787` | 首选本地端口 |
| `--model <model>` | `AGENTX_MODEL` | `gpt-5.6-luna` | 具体上游模型 ID |
| `--provider <id>` | `AGENTX_PROVIDER` | 无 | 上游 Provider（`opencode`、`deepseek`、`openrouter`） |
| `--background-model <id>` | `AGENTX_BACKGROUND_MODEL` | 无 | Claude Code 后台（haiku）通道使用的模型 |
| `--retry <n>` | `AGENTX_RETRY` | `3` | 上游 429/502/503/504 的重试次数(0 表示禁用) |
| `--client-protocol <anthropic\|openai>` | | `anthropic` | 仅 `exec`:决定给被启动程序注入哪种形状的环境变量 |
| `--verbose` | `AGENTX_LOG_LEVEL` | `info` | 预留的详细日志选项 |
| | `AGENTX_USAGE_DIR` | `~/.config/agentx` | Token 用量统计存储目录 |

如果首选端口已被占用，适配器会依次尝试后续端口。非回环监听必须显式指定，并且只应在可信网络中使用：

```bash
agentx proxy --host 0.0.0.0
```

`agentx doctor` 支持 `--client <claude|codex|all>`（默认 `all`）只检查指定客户端，并支持 `--offline` 跳过依赖网络的检查；跳过的项会在报告中标出。

## 凭据与 Provider Profile

凭据完全通过环境变量提供：AgentX 专用的变量统一带 `AGENTX_` 前缀（如 `AGENTX_OPENCODE_API_KEY`），避免与用户为其他工具设置的同名变量冲突；运行时解析后按原始 Key 注入上游请求，前缀只存在于变量命名空间中。如果已经设置了不带前缀的旧变量（如 `OPENCODE_API_KEY`），也会被直接使用。凭据查找优先级为：`--api-key`、`AGENTX_<PROVIDER>_API_KEY`、旧的 `<PROVIDER>_API_KEY`、交互式输入。交互式输入的 Key 仅当前会话有效，AgentX 会打印可粘贴到 shell profile 的 `export …` 行；AgentX 不会自行修改你的 shell profile。

非敏感运行时状态统一保存在 `~/.config/agentx/runtime.json`：包含每个客户端的默认模型、每个 Provider 最近使用的模型和最近一次选择。API Key 不会写入该文件或任何由 AgentX 管理的存储；AgentX 也不会修改你的 shell profile。

对于 Claude Code，本地 Token 会注入为 `ANTHROPIC_AUTH_TOKEN`，而不是 `ANTHROPIC_API_KEY`。这与 DeepSeek 等 Provider 的接入方式一致，可以避免 Claude Code 弹出自定义 API Key 确认页面；上游真实 Key 始终只保留在 Adapter 中。

## Provider

适配器分为三层：面向 Claude Code/Codex 的客户端层、负责 Anthropic Messages 与 OpenAI Responses/Chat Completions 的协议适配层，以及负责上游平台接入的 Provider 层。

当前支持的上游 Provider：

| Provider | 凭据（推荐） | 凭据（兼容） | 示例模型 |
| --- | --- | --- | --- |
| OpenCode | `AGENTX_OPENCODE_API_KEY` | `OPENCODE_API_KEY` | `gpt-5.6-luna` |
| DeepSeek | `AGENTX_DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro` |
| OpenRouter | `AGENTX_OPENROUTER_API_KEY` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4` |

### 选择 Provider 和模型

对于脚本和高级用法，`--provider`/`--model` 可以为单次调用覆盖已配置的运行时：

```bash
agentx claude --provider deepseek --model deepseek-v4-pro
agentx codex --provider openrouter --model anthropic/claude-sonnet-4
```

这两个参数属于「高级 / 自动化 API」：日常切换 Provider 应该通过交互式运行时配置完成（见[运行时配置](#运行时配置)）。对应的环境变量是 `AGENTX_PROVIDER` 和 `AGENTX_MODEL`（同样会跳过交互式启动器）。Provider 凭据只由 Adapter 使用，不会注入客户端进程。

Claude Code 的所有模型档位（主模型、opus/sonnet/haiku 别名、子代理）都会固定为所选模型——用户的选择对所有流量生效，包括 Claude Code 通过 haiku 档位发起的小型后台请求（权限检查、主题检测、摘要等）。可选地，通过 `--background-model <id>`（或环境变量 `AGENTX_BACKGROUND_MODEL`）可以仅将这一后台通道路由到同一 Provider 下的其他模型——当主模型是重量级推理模型、其非流式辅助调用超过客户端超时时间时会很实用。凡是指定了目标 Provider 实际提供的模型的请求都会按原样转发；未知模型 id 则回退到配置的模型。

### 自定义 Provider

除了三个内置 Provider，你还可以注册任意 OpenAI 或 Anthropic 兼容的端点——本地模型服务（Ollama、vLLM、LM Studio）、内部网关，或其他任何兼容 API。在交互式启动器的「Change Provider」列表里选择 **Add custom provider…**，依次填入名称、Base URL 和协议；已经有自定义 Provider 时,同一个列表还会提供 **Remove custom provider…**。

对于脚本和非交互场景，`--base-url` 可以在不打开启动器的情况下定义(并持久化)一个自定义 Provider——`--provider` 作为它的显示名，`--protocol` 选择上游协议形状(默认 `chat-completions`，也可以是 `responses`/`anthropic`)：

```bash
# 本地 OpenAI 兼容服务(例如 Ollama)
agentx exec --provider "My Local LLM" --base-url http://localhost:11434 --protocol chat-completions --model llama3 -- claude

# 说原生 Anthropic Messages API 协议的 Provider
agentx exec --provider "Internal Anthropic Gateway" --base-url https://gateway.internal --protocol anthropic --model claude-x -- claude
```

注册之后,直接用它的 id(名称转小写、空格转连字符)复用,不用再重复 `--base-url`：

```bash
agentx claude --provider my-local-llm
```

凭据的处理方式和内置 Provider 完全一样——在环境变量里设置 `AGENTX_<ID>_API_KEY`(大写、下划线分隔),或者在提示时手动输入；连接元数据会持久化到 `runtime.json`,但 API Key 绝不会。要把一个自定义 Provider 彻底移除(定义本身连同所有保存的记忆,而不只是某个过期的 model id)：

```bash
agentx forget --provider my-local-llm --remove-provider
```

内置 Provider 不能用这种方式移除。无论自定义 Provider 说的是哪种协议，Claude Code 和 Codex 都能访问它——Codex 通过和访问 Chat Completions 上游相同的本地转换层，也能访问协议为 `anthropic` 的自定义 Provider(见 [API 转换](#api-转换))。

### 运行时配置

如果在交互式终端启动 `claude`、`codex` 或 `pi` 时没有指定 `--provider`/`--model`，且没有设置 `AGENTX_PROVIDER`/`AGENTX_MODEL`，AgentX 会显示交互式运行时启动器，而不是要求你凭空做选择：

```
┌  Claude Code — AgentX
│
◆  Provider
│  ● OpenCode  (connected · 2 models)
│    DeepSeek  (connected · 2 models)
└
```

当前运行时会从已保存的默认值加载：存在已保存默认时先显示快捷菜单，可以直接启动，或进入选择器重新选择 Provider / 模型。模型选择支持搜索：输入文字即可按模型 id 过滤列表，↑/↓ 选择、Enter 确认。切换 Provider 会自动为该 Provider 解析模型，并记住每个 Provider 最近使用的模型。完成选择后会自动保存为该客户端的默认运行时，下次启动直接从该默认值开始。非交互场景会跳过界面，按「`--provider` → 环境变量 → 已保存默认值 → 内置默认值」解析。

#### 原生启动

Claude Code 和 Codex 在 AgentX 之外都有自己的登录与计费方式，因此两者都支持原生启动——完全绕开 AgentX：不做 Provider/模型解析、不启动本地 Adapter、不注入任何 `ANTHROPIC_*`/`OPENAI_*` 环境变量，客户端的运行方式与你直接手动启动它完全一致。两种方式都可以触发：

```bash
agentx claude --native
agentx codex --native
```

或者在已保存默认值时弹出的快捷菜单中选择「Launch native (skip AgentX)」。`--native` 与 `--provider`/`--model` 同时出现时会静默忽略后者，因为此时已经没有需要 AgentX 配置的内容。`pi` 没有原生模式——它始终依赖一个 OpenAI 兼容后端，因此没有「原生」可以回退。

如果 `--native` 是嵌套运行在 AgentX 自己启动的客户端内部——例如在由 `agentx claude` 启动的 Claude Code 会话中再次输入 `agentx claude --native`——继承到的环境仍然带着外层启动注入的 `ANTHROPIC_*`/`OPENAI_*` 覆盖值。AgentX 会检测到这种情况（依据它在每个自建环境中都会设置的一个内部标记），并在启动子进程前只清除自己注入的那些变量，使嵌套的客户端仍然以原生方式启动，而不是悄悄指回本该被跳过的 Adapter。一个从未经过 AgentX 的、纯手工配置的环境——即便其中恰好使用了相同的变量名——则完全不会被改动。

## Codex 支持

使用本地 OpenAI 兼容 Responses API 启动 Codex：

```bash
npx @tanzz/agentx codex
npx @tanzz/agentx codex --model gpt-5.6-luna
```

启动器通过 `-c` 参数定义一个内联的 `agentx` 模型 Provider，指向 `http://127.0.0.1:<port>/v1`，其 Bearer Token 是以 `OPENAI_API_KEY` 注入的临时本地 Token。启动时还会生成一份模型目录（`~/.config/agentx/codex-models.json`，经 `model_catalog_json` 传入），让目录中的模型——包括你在启动器中输入的自定义 OpenRouter 模型 id——以真实元数据加载，而不是触发 Codex 的 fallback 元数据警告：上下文窗口与输出上限对所有 Provider 生效，在可用时取自公开注册表 models.dev，models.dev 缺失的模型回退到 OpenRouter 公开目录，否则使用保守默认值。DeepSeek 的 `deepseek-v4-pro`/`deepseek-v4-flash` 是个例外：它们是 OpenCode 自己的品牌命名（同时通过 OpenCode 网关和直连的 DeepSeek Provider 提供），两个公开注册表都没有对应词条，因此目录会显式声明它们约 1M 的真实上下文窗口，而不是回退到保守的 128k——否则 Codex 会比必要时机早得多地对长时间 DeepSeek 会话做自动压缩，这与 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 为 Claude Code 修复的是同一类问题（见[模型和路由](#模型和路由)）。新版 Codex 已不再读取那些环境变量，该方式可以正常工作，并完全绕过 Codex 的登录页——无需 ChatGPT 登录或 `~/.codex/auth.json`，也不会修改你已有的 `~/.codex/config.toml`。Codex 现在同时支持 Responses 和 Chat Completions 模型：Responses 模型直接转发，Chat Completions 模型在本地 Responses 边界进行协议转换。因此 Provider 目录中的模型都可以供 Claude Code 和 Codex 使用。

Pi Agent 通过与 Codex 相同的 OpenAI 兼容环境启动（`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`），其请求也经过同一个本地 Responses 边界转换，因此可以获得与 Codex 相同的 DeepSeek reasoning/tool_choice/错误处理转换。但它不会收到生成的模型目录，所以 AgentX 目前没有渠道像对 Claude Code 或 Codex 那样向它声明模型的上下文窗口。

## 模型和路由

只有在未指定 Provider 或选择的 Provider 为 `opencode` 时，才会拉取 OpenCode 模型目录；且仅当上次拉取的快照（持久化在 `runtime.json` 中）距今已超过 24 小时才会真正发起网络请求——快照未过期则直接复用，不产生网络往返。跳过拉取、尚无快照或拉取失败时，会使用磁盘上最近一次持久化的快照；若从未成功拉取过，则使用下面内置的回退目录：

| 模型 | 上游协议 |
| --- | --- |
| `gpt-5.6-luna` | Responses API |
| `deepseek-v4-pro` | Chat Completions API |
| `deepseek-v4-flash` | Chat Completions API |
| `minimax-m3`、`minimax-m2.7`、`minimax-m2.5` | Chat Completions API |
| `kimi-k3`、`kimi-k2.7-code`、`kimi-k2.6`、`kimi-k2.5` | Chat Completions API |
| `glm-5.3`、`glm-5.2`、`glm-5.1`、`glm-5` | Chat Completions API |
| `mimo-v2.5-pro`、`mimo-v2.5`、`hy3` | Chat Completions API |

接口返回的模型使用 Responses API（`gpt-5.6-luna`）或 Chat Completions API（其余模型）。本地 `/v1/models` 端点始终反映当前目录；请求必须能解析到具体已配置的模型。

OpenRouter Provider 接受任意模型 id（默认使用 `OPENROUTER_MODEL` 或 `openai/gpt-4o-mini`）。交互式启动器的模型选择列表额外提供三个选项：

- **Search / enter any model id…** — 直接输入任意 OpenRouter 模型 id（例如 `anthropic/claude-sonnet-4.5`）。
- **Browse OpenRouter catalog…** — 浏览从 `https://openrouter.ai/api/v1/models` 拉取的全量实时目录（约 400 个模型），可以搜索到真实存在的厂商前缀 id（例如 `deepseek/deepseek-v4-pro`），无需盲打。目录会持久化到 `runtime.json`，供离线比对。
- **Forget a saved model…** — 打开限定在当前 Provider 的「已保存模型」管理器，直接在当前选择器里清掉被改名/下架的自定义模型 id，无需退出选择流程。

由于 OpenRouter 接受自由输入的模型 id，一次启动可能保存了上游后来改名或下架的模型（比如免费模型被改名为真实厂商 id）。你可以在模型选择器内部直接清理这些过期 id，也可以运行 `agentx forget` 进入完整的管理流程（见上文 [`forget`](#forget)）。

显式选择具体模型：

```bash
agentx claude --model gpt-5.6-luna
```

基于请求大小或工具数量的隐式路由已移除。如果 Claude 后台通道需要同 Provider 的其他模型，请显式配置 `--background-model`。

Claude Code 遇到不认识的模型时，会假定它使用默认的约 200k token 上下文窗口，并早早触发自动压缩。DeepSeek 的 `deepseek-v4-flash`/`deepseek-v4-pro`（以及它们的 `[1m]` 变体）实际拥有大得多的上下文窗口，因此 `claude` 启动器会为这些模型自动声明 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 与 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（除非你已自行设置过这两个环境变量）。如果没有这一步，长时间的 DeepSeek 会话会被过早自动压缩，悄无声息地丢弃相当大一部分对话内容。

## API 转换

适配器不会持久化对话历史。Claude Code 会在每次请求中携带完整对话；唯一的本地持久化是聚合后的 Token 用量统计（见 [Token 用量统计](#token-用量统计)）。

当前支持的转换包括：

- Anthropic `system` 内容转换为 Responses `instructions` 或 Chat Completions system 消息
- `max_tokens` 转换为上游输出 Token 限制
- Anthropic 文本消息与响应文本
- Anthropic 流式事件与上游 SSE 事件转换
- Anthropic `tools`、`tool_use`、`tool_result` 与 function tool、function call output 转换
- Anthropic `thinking` / `output_config.effort` 转换为上游的思考控制参数（Chat Completions 上是 DeepSeek 的 `thinking`/`reasoning_effort`，Responses API 上是 `reasoning.effort`）
- Anthropic `tool_choice` 转换为上游 Chat Completions 或 Responses 对应的 tool-choice 结构
- Responses 和 Chat Completions usage 字段转换为 Anthropic usage 字段
- Responses 请求/响应与原生 Anthropic Messages API 上游之间的双向转换(针对协议为 `anthropic` 的自定义 Provider),包括流式响应——这是唯一一条 Codex 也会用到、而不仅限于 Claude Code 的转换方向,因为 Codex 只会看到本地的 Responses 端点

DeepSeek 的思考模式要求每个 assistant 回合的 `reasoning_content` 必须回传，并且要挂在它所引出的那个 tool call 所在的同一条消息上；适配器会把一条 assistant 消息的文本、reasoning 与 tool call 保持在同一条消息里，而不是拆分成多条，并且只对 DeepSeek 转发 `reasoning_content`（其它 Chat Completions 上游并不期望这个字段）。当上游以异常方式结束——`content_filter`、`insufficient_system_resource`，或者流结束时既没有 `finish_reason` 也没有 `[DONE]`——都会转换为错误返回，而不是被悄悄当成正常的 `end_turn`。

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

用量统计不通过 HTTP 暴露。适配器没有 `/usage/*` 端点；请使用
[`agentx usage`](#usage) 命令读取数据，该命令直接读取存储后端。

### 存储与数据

- 统计保存在 `~/.config/agentx/usage.db`（或 `usage.json` 回退）。
- `AGENTX_USAGE_DIR` 可覆盖存储目录。
- 只保存 Token 数量和元数据——绝不保存 prompt、工具参数或对话内容。

## 安全与隐私

- 上游 API Key 只从 CLI 或环境变量读取，并只发送给所配置的 Provider。
- Claude Code 每次只收到适配器进程生成的随机本地 Bearer Token，该 Token 不会持久化。
- 默认监听 `127.0.0.1`，不会修改 shell profile 或永久操作系统环境变量。
- 适配器没有 `/usage/*` 之类可读取已存储数据的未认证 HTTP 端点；用量统计只能通过 [`agentx usage`](#usage) 命令在本地读取。
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

测试覆盖请求/响应转换、system instructions、流式事件、工具调用、Provider 路由、Chat Completions 转换，以及 Token 用量适配器、存储和用量查询 API。测试不需要 API Key，也不依赖网络。

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

运行 `agentx doctor`，确认 API Key 和模型可用，并检查到上游 Provider 的网络访问。提交 Issue 时不要粘贴 API Key 或 Authorization Header。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请保持改动聚焦，为协议行为补充或更新测试，运行 `npm test`，并避免提交 Secret、`dist` 和 `node_modules` 等生成目录。

## 许可证

MIT © tzzs
