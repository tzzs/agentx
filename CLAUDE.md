# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库中工作时提供操作指引。

## 这是什么

`agentx` 是一个本地 Anthropic/OpenAI 兼容的 API 适配器，让 Claude Code、Codex 或 Pi 可以对接 OpenCode 以及其他上游模型提供商。它会启动一个回环（loopback）HTTP 服务器，将临时凭据注入到被启动的客户端进程中，并在客户端退出后关闭。

## 常用命令

```bash
npm ci            # 按 package-lock.json 安装精确依赖
npm run build     # 编译 TypeScript 到 dist/（使用 tsc）
npm test          # 先构建，再执行 node --test（在 dist/ 下自动发现测试文件；Windows 的 cmd.exe 不做 glob 展开，故用目录自动发现而非 dist/test/*.test.js）
```

运行单个测试文件：`npm run build && node --test dist/test/catalog.test.js`
运行完整的本地 CI 检查（安装 + 测试 + 包校验）：`make check`

`Makefile` 提供了一些便捷目标，运行 `make` 可查看完整列表。常见的有：`make doctor`、`make test`、`make build`、`make version`。

## 架构

本包声明了 `"type": "module"` 并使用 `rootDir: "."` 编译，因此**所有 import 都使用 `.js` 后缀，且所有路径以仓库根目录为基准**（例如 `import { loadConfig } from "./config.js"`，测试位于 `test/` 下，导入如 `"../src/catalog.js"`）。

### 两套协议转换路径

适配器对外暴露两个请求端点，在三种 API 格式之间进行转换。本地面向客户端（client-facing）的端点是：
- `POST /v1/messages` — Anthropic Messages API（Claude Code 使用）
- `POST /v1/responses` — OpenAI Responses API（Codex 使用）

上游提供商使用 Responses 协议或 Chat Completions 协议。路由决策以每个模型的 `protocol` 字段体现。

转换函数集中在 `src/convert/`，按**上游协议**（而非转换方向）拆分为四个文件：

- `shared.ts` — 跨方向 helper：图片/effort/thinking/三套 tool-choice 转换、采样参数、JSON 解析等
- `chat.ts` — 上游 = Chat Completions 的全部方向：`toChatRequest` / `fromChatResponse`（Anthropic ↔ Chat Completions）、`toChatCompletionsRequest` / `fromChatResponseToResponses`（Responses ↔ Chat Completions）
- `responses.ts` — 上游 = Responses：`toResponsesRequest` / `fromResponsesResponse`（Anthropic ↔ Responses）
- `anthropic.ts` — 上游 = Anthropic（自定义 Provider 声明 `protocol: "anthropic"` 时专属）：`toAnthropicRequest` / `fromAnthropicResponse`（Responses ↔ Anthropic；Codex 只会看到本地 Responses 端点，仍需经此转换才能到达一个原生 Anthropic 上游）
- `index.ts` — barrel 导出，公共函数名不变

`src/catalog.ts` 收敛为纯路由模块，只保留 `providers`（模型列表）/`providerFor`（按 model 选路由）/`honorRequestedModel`，不再含任何转换函数。

对应的流式转换位于 `src/streaming/`（模块化目录，非单一文件）：`pipeChatStreamToResponses`（上游 Chat Completions SSE → 本地 Responses SSE）、`pipeResponsesStream`（上游 Responses 或 Chat Completions SSE → 本地 Anthropic SSE）、`pipeAnthropicPassthrough`/`pipeAnthropicStreamToResponses`（上游 Anthropic SSE ↔ 本地两端点，自定义 Provider 专属）。

### 模型路由与提供商注册表

`src/providers/registry.ts` 是提供商和模型的唯一数据来源。每个 `ProviderDefinition` 列出模型、API key 环境变量名和协议。`refreshProviderCatalog()` 按需刷新目录：仅在未绑定 Provider 或绑定 `opencode` 时拉取 OpenCode 模型列表；只有生成 Codex catalog 时才拉取 models.dev / OpenRouter 元数据。`src/catalog.ts` 重新导出扁平化的模型列表以及 `providerFor(model, providerId)` 解析器，该解析器会匹配模型定义，未知则抛出异常。OpenRouter 接受任意模型 id（注册表条目相当于透传）。

没有隐式 `auto` 路由；运行时必须解析为具体模型。Claude 的后台通道只能通过显式 `backgroundModel` 配置切换。

### Token 用量统计

`src/usage/` 是统计系统：`types.ts` 定义统一的 `TokenUsage`、`UsageStore` 等类型，`collector.ts` 归一化并持久化，`storage.ts` 提供 SQLite（`node:sqlite`）/ JSON / 内存三种存储后端，`cli.ts` 渲染 `agentx usage` 输出（不做成本估算——`pricing/` 已被删除，详见 git log）。`src/providers/usage/` 是 Provider 用量适配器，负责把各 Provider 的原始响应字段映射为 `TokenUsage`（`extractUsage(response, model, ctx)`）。

**架构规则**：核心层只理解 `TokenUsage`，绝不解析 Provider 原始响应；Provider 层只做字段映射，不做统计逻辑；新增 Provider 只需添加用量适配器与定价配置，无需改动核心运行时、存储或 CLI。每请求成功后由 `src/server.ts` 自动调用 `collector.record(usage)`（非流式与流式都要覆盖）。

### 请求流程

入口 `src/cli.ts` 解析选项（CLI 参数优先于 `AGENTX_*` 环境变量，通过 `loadConfig`），解析 API key，保存非机密 profile，启动适配器（`src/server.ts`），然后用指向本地端点的 `ANTHROPIC_*`（Claude）或 `OPENAI_*`（Codex/Pi）环境变量启动客户端（`src/process.ts`）。`src/server.ts` 是无状态的——每个请求都携带完整对话，服务端不持久化任何内容。

凭据完全来自环境变量（在 `src/credentials.ts` 中解析）：`--api-key` → `AGENTX_<PROVIDER>_API_KEY`（带前缀的规范变量）→ 旧的无前缀变量（如 `OPENCODE_API_KEY`，直接兼容使用）→ 交互式提示（仅当前会话有效）。AgentX 自身不持久化任何密钥；带前缀的命名可避免与用户为其他工具设置的同名变量冲突。非敏感运行时状态只保存在 `runtime.json`；API key 绝不会写入任何 AgentX 状态文件。

## 关键约束

- 测试不依赖网络，也不需要 API key——请保持这一点。
- 上游 API key 绝不能传给客户端进程或写入日志。客户端只会看到随机生成的每进程本地 token。
- 新增提供商或模型意味着修改 `src/providers/registry.ts`；catalog、CLI help 和 README 中的模型表都源于或复制了这些内容，应保持一致。
- 公共端点、help 文本和 CLI 命令在 `README.md`（英文）和 `README.zh-CN.md`（中文）中有文档说明；修改用户可见行为时两个文件都要更新。
- Release Please 依据 conventional commit 消息驱动发版；请使用 conventional commit 前缀（如 `feat:`、`fix:`）。
