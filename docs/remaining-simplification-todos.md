# AgentX 剩余精简待办

> 更新时间：2026-08-26  
> 背景：已完成 runtime/profile 状态合并、Codex catalog 收窄、移除 `--model auto` 隐式路由，以及模型目录按需刷新。本文档记录后续建议继续执行的精简项。

## 优先级总览

| 级别 | 待办 | 主要收益 |
| --- | --- | --- |
| A | 删除成本估算 | 避免误导性价格输出，减少无用模块 |
| B | 收缩或删除 `/usage/*` HTTP API | 减少无认证查询面 |
| C | 删除凭据自动写入 shell profile | 让实现与安全边界一致 |
| D | 拆分或删除 Provider quota 查询 | 澄清 CLI 语义 |
| E | 删除未接入的 Anthropic / Google 用量与定价层 | 移除预留复杂度 |
| F | 简化 usage capabilities 层 | 降低抽象成本 |
| G | 删除客户端自动安装流程 | 缩小 launcher 职责 |
| H | 重新评估 Pi 支持 | 减少未充分验证的客户端路径 |
| I | 增强 `doctor` 的范围控制 | 改善诊断体验 |
| J | 拆分 `src/streaming.ts` | 提高协议层可维护性 |

## A. 删除成本估算

当前 `src/usage/pricing/` 会把未知模型 fallback 到 OpenAI 价格，DeepSeek 也复用 OpenAI 定价。OpenCode / OpenRouter 的真实价格高度依赖具体模型和上游协议，因此现在的 Cost 输出容易误导。

### 建议方案

- CLI 只保留 Token 统计。
- 删除 Cost 列。
- 删除或归档以下目录：
  - `src/usage/pricing/`
- 同步删除 pricing 相关测试。
- 更新 README 与 CLAUDE.md。

### 未来如需恢复

必须使用显式的 per-provider / per-model rate table；缺失价格应显示 `unknown`，不能 fallback 到 OpenAI 价格。

---

## B. 收缩或删除 `/usage/*` HTTP API

本地已经有 `agentx usage`，HTTP 查询端点不是 Claude Code / Codex 正常运行所必需。当前端点无需认证，虽然默认 loopback 风险较低，但绑定非回环地址时会扩大暴露面。

### 当前涉及端点

- `GET /usage/session?id=...`
- `GET /usage/session/<id>`
- `GET /usage/providers`
- `GET /usage/stats`

### 推荐方案

直接删除全部 `/usage/*` HTTP 端点，只保留 CLI 从本地 SQLite / JSON 存储读取统计。

如果确实要保留 HTTP 查询能力：

- 至少要求 bearer token。
- 默认只允许 loopback。
- 文档明确说明非回环绑定时不要暴露查询接口。
- 可以只保留一个聚合端点，例如 `/usage/stats`。

---

## C. 删除凭据自动写入 shell profile 的能力

README 的安全叙事说明 AgentX 不修改 shell profile，但当前交互输入 key 后仍可能追加 export 行到 shell profile。这是设计上的矛盾。

### 建议方案

- 删除 `persistCredentialToProfile()`。
- 删除 shell profile 探测和转义逻辑。
- 交互输入的 key 只保留在当前进程。
- 打印手动持久化指引即可。
- `auth login` 可退化为配置说明命令。
- 长期可以只保留 `auth status`。

这样可以让 AgentX 保持更清晰的安全承诺：自身不存储密钥，也不修改用户 shell 配置文件。

---

## D. Provider quota 查询拆出去或删除

`agentx usage --provider deepseek/openrouter` 实际是远程余额查询，而不是适配器处理的请求 Token 用量统计。两者共用同一个命令会导致语义混乱。

而且当前只有两个 provider 支持 quota 查询；OpenCode 明确不支持公开额度接口。

### 方案一：拆分

新增独立命令：

```bash
agentx quota --provider deepseek
agentx quota --provider openrouter
```

然后让 `agentx usage` 只表示本地 Token usage。

### 方案二：删除

如果没有真实需求，可以直接删除 quota 查询逻辑和相关测试，等需要时再按 provider capability 扩展。

---

## E. 删除未接入的 Anthropic / Google 用量与定价层

当前 upstream registry 只有 OpenCode、DeepSeek 和 OpenRouter，但用量系统保留了 Anthropic 与 Gemini 的适配代码。

### 可能属于预留复杂度的内容

- Anthropic usage adapter
- Gemini usage adapter
- Anthropic pricing provider
- Google pricing provider
- capabilities 中对应的 fallback 表

### 建议

除非近期确定接入 Anthropic 或 Gemini upstream，否则应删除这些代码或移到未来分支。

核心运行时已经依赖统一的 `TokenUsage` 抽象；未来重新加入新上游时，只需重新补充字段映射，不需要提前维护这些模块。

---

## F. 简化 usage capabilities 层

`capabilitiesFor()` 当前主要影响 usage CLI 是否显示 Cached 列。实际消费面很窄，但保留了 registry capabilities 与独立 fallback 表两套来源。

### 建议方案

改成简单的展示规则：

```text
只要统计结果中存在 cachedTokens > 0，就显示 Cached 列。
```

然后删除整个 capabilities 抽象和 fallback 表。

---

## G. 删除客户端自动安装流程

找不到 `claude` / `codex` 时，launcher 会交互式询问是否执行全局 npm 安装。这个功能方便，但会让 AgentX 额外承担外部安装器的职责，也增加错误处理路径。

### 建议方案

退化为清晰的提示：

```bash
✗ Codex not found.
Install:
  npm install -g @openai/codex
Then re-run:
  agentx codex
```

保留 `doctor` 检测客户端是否可用即可。

---

## H. Pi 支持需要重新评估

Pi 目前通过普通 OpenAI-compatible environment 启动，但文档对其兼容性的描述偏强。

### 建议

- 如果没有明确活跃用户，直接从核心命令中移除 `pi`。
- 如果保留，应明确支持的 Pi 版本、验证范围和限制。
- 不应把 Pi 与经过专门 inline-provider 处理的 Codex 路径混同描述。

---

## I. 增强 `doctor` 的范围控制

`doctor` 目前总是同时检查 Claude Code 和 Codex，即使用户只想调试其中一个。

### 建议接口

```bash
agentx doctor --client claude
agentx doctor --client codex
```

同时建议增加：

```bash
agentx doctor --offline
```

并明确显示网络检查是否被跳过。

---

## J. 拆分 streaming.ts

`src/streaming.ts` 是目前最大的协议源码文件，包含三条转换路径：

1. Chat Completions → Responses
2. Responses passthrough
3. Responses / Chat → Anthropic

这不是紧急问题，但随着协议行为继续增强，单文件会提高维护风险。

### 建议结构

```text
src/streaming/
  common.ts
  chat-to-responses.ts
  responses-passthrough.ts
  to-anthropic.ts
```

公共 SSE 写入、heartbeat、usage capture、reasoning delta 解析和错误事件逻辑应收敛到 common 模块。

---

## 建议下一批执行顺序

如果继续做减法，建议一次只处理三项：

1. **A：删除 cost estimation**
2. **B：删除 `/usage/*` HTTP 查询面**
3. **C：删除凭据写入 shell profile 的能力**

这三项都能明显缩小攻击面、降低误导性输出，并让 AgentX 回归“本地协议适配器 + 客户端启动器”的核心定位。
