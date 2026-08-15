# opencode-adapter

[![CI](https://github.com/tzzs/opencode-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/tzzs/opencode-adapter/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-adapter)](https://www.npmjs.com/package/opencode-adapter)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

通过本地 Anthropic 兼容适配器，让 Claude Code 使用 OpenCode Go 提供的模型。适配器负责将 Anthropic Messages API 请求转换为上游 Responses API 或 Chat Completions API 请求，为子进程注入临时认证信息，并在子进程退出后清理本地服务。

> **项目状态：** 当前为早期版本。项目包含协议转换层和自动化测试，但在生产使用前仍应使用自己的 OpenCode Go 账号验证真实上游 API 的兼容性。

## 快速开始

依赖环境：

- Node.js 20 或更高版本
- OpenCode Go API Key
- 已安装且能在 `PATH` 中找到 `claude` 的 Claude Code

```bash
export OPENCODE_GO_API_KEY="your-api-key"
npx opencode-adapter claude
```

该命令会启动仅监听本机回环地址的适配器，等待服务就绪，然后使用临时 `ANTHROPIC_*` 环境变量启动 Claude Code，转发终端输入输出，并在 Claude Code 退出后关闭适配器。

真实的 OpenCode Go Key 不会传给 Claude Code。Claude Code 每次只会收到一个随机生成的本地临时 Token。

## 安装

无需安装，直接使用：

```bash
npx opencode-adapter claude
```

全局安装：

```bash
npm install --global opencode-adapter
opencode-adapter claude
```

## 命令

### `claude`

同时启动适配器和 Claude Code：

```bash
opencode-adapter claude
opencode-adapter claude --model deepseek-v4-flash
opencode-adapter claude --port 9000 --host 127.0.0.1
```

### `proxy`

只启动本地适配器，按 `Ctrl+C` 停止：

```bash
opencode-adapter proxy
```

本地 API 地址为 `http://127.0.0.1:<port>`，提供 `GET /health`、`GET /v1/models` 和 `POST /v1/messages`。

### `exec`

使用临时 Anthropic 环境变量执行任意命令：

```bash
opencode-adapter exec -- claude
opencode-adapter exec -- opencode
opencode-adapter exec -- my-command --argument
```

在当前平台支持的范围内，命令的 stdin、stdout、stderr、退出码和终止信号都会被转发。

### `doctor`

检查本地环境和配置：

```bash
opencode-adapter doctor
```

报告包含 Node.js、平台/WSL 状态、CPU 架构、API Key 是否存在、支持的模型，以及 Claude Code 是否可被发现。

### `version`

```bash
opencode-adapter version
```

## 配置

CLI 参数优先于环境变量。默认模型为 `gpt-5.6-luna`。

| CLI 参数 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--api-key <key>` | `OPENCODE_GO_API_KEY` | 无 | OpenCode Go 凭据 |
| `--host <host>` | `OPENCODE_ADAPTER_HOST` | `127.0.0.1` | 本地监听地址 |
| `--port <port>` | `OPENCODE_ADAPTER_PORT` | `8787` | 首选本地端口 |
| `--model <model>` | `OPENCODE_ADAPTER_MODEL` | `gpt-5.6-luna` | 模型名或 `auto` |
| `--verbose` | `OPENCODE_ADAPTER_LOG_LEVEL` | `info` | 预留的详细日志选项 |

如果首选端口已被占用，适配器会依次尝试后续端口。非回环监听必须显式指定，并且只应在可信网络中使用：

```bash
opencode-adapter proxy --host 0.0.0.0
```

## 模型和路由

当前内置 Provider：

| 模型 | 上游协议 |
| --- | --- |
| `gpt-5.6-luna` | Responses API |
| `deepseek-v4-pro` | Chat Completions API |
| `deepseek-v4-flash` | Chat Completions API |

显式选择模型：

```bash
opencode-adapter claude --model gpt-5.6-luna
```

使用 `--model auto` 时，短请求使用 `deepseek-v4-flash`，较大请求使用 `deepseek-v4-pro`，包含工具或较大上下文的请求使用 `gpt-5.6-luna`。这是一个简单的初版路由器，不是基于基准测试的模型推荐系统。

## API 转换

适配器是无状态的。Claude Code 会在每次请求中携带完整对话，适配器不会在本地持久化对话历史。

当前支持的转换包括：

- Anthropic `system` 内容转换为 Responses `instructions` 或 Chat Completions system 消息
- `max_tokens` 转换为上游输出 Token 限制
- Anthropic 文本消息与响应文本
- Anthropic 流式事件与上游 SSE 事件转换
- Anthropic `tools`、`tool_use`、`tool_result` 与 function tool、function call output 转换
- Responses 和 Chat Completions usage 字段转换为 Anthropic usage 字段

适配器只负责工具协议转换，不会执行工具，也不会持久化 prompt、工具参数或对话状态。

## 安全与隐私

- 上游 API Key 只从 CLI 或环境变量读取，并只发送给 OpenCode Go。
- Claude Code 每次只收到适配器进程生成的随机本地 Bearer Token，该 Token 不会持久化。
- 默认监听 `127.0.0.1`，不会修改 shell profile 或永久操作系统环境变量。
- 日志不应包含 API Key、Authorization Header、用户 prompt 或敏感工具参数。
- `--host 0.0.0.0` 会主动暴露网络服务，请配置适当的网络访问控制。

## 平台支持

启动器面向 Linux、macOS、Windows 和 WSL 设计。WSL 通过 `WSL_INTEROP` 检测，并使用当前 WSL 中的 Node.js，不依赖 Windows Node.js 安装。Claude Code 会按照平台的常规可执行文件规则发现，包括 Windows shell 执行方式。

## 开发

```bash
git clone https://github.com/tzzs/opencode-adapter.git
cd opencode-adapter
npm ci
npm test
npm run build
```

项目使用 TypeScript、Node.js 原生 `fetch`、Node.js ESM 和内置 `node:test` 测试运行器。测试会先编译到 `dist/test`，再执行编译后的测试。

测试覆盖请求/响应转换、system instructions、流式事件、工具调用、模型路由和 Chat Completions 转换。测试不需要 API Key，也不依赖网络。

## CI 与发布

GitHub Actions 会在每次 push 和针对 `main` 的 Pull Request 中运行构建、测试和 npm 包内容检查。发布配置位于 `.github/workflows/publish.yml`：

1. 在 GitHub 的 `npm` environment 中添加 `NPM_TOKEN` Secret。
2. 推送匹配 `v*.*.*` 的版本标签，或手动运行 **Publish package** 工作流。
3. 工作流会运行完整测试，并使用 provenance 发布到 `https://registry.npmjs.org`。

## 故障排查

**`OpenCode Go API key not found`**

设置 `OPENCODE_GO_API_KEY`，或传入 `--api-key <key>`。本地服务启动前必须提供 Key。

**找不到 Claude Code**

安装 Claude Code，确保在同一个 shell 的 `PATH` 中可以执行 `claude`，然后运行 `opencode-adapter doctor`。

**端口被占用**

适配器会从配置端口开始自动尝试后续端口。也可以使用 `--port` 更换起始端口。

**上游请求失败**

运行 `opencode-adapter doctor`，确认 API Key 和模型可用，并检查到 OpenCode Go API 的网络访问。提交 Issue 时不要粘贴 API Key 或 Authorization Header。

## 参与贡献

欢迎提交 Issue 和 Pull Request。请保持改动聚焦，为协议行为补充或更新测试，运行 `npm test`，并避免提交 Secret、`dist` 和 `node_modules` 等生成目录。

## 许可证

MIT © opencode-adapter contributors
