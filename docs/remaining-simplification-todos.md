# AgentX 剩余精简待办

> 更新时间：2026-08-28
> 背景：已完成 runtime/profile 状态合并、Codex catalog 收窄、移除 `--model auto` 隐式路由、模型目录按需刷新、凭据 shell profile 自动写入移除、`doctor` 按 client/`--offline` 范围控制、`streaming.ts` 拆分为模块化目录、cost estimation 删除、`agentx quota` 从 `usage` 拆分、未接入的 Google usage/pricing 及整个 capabilities 抽象删除。本文档记录后续建议继续执行的精简项——已完成的条目直接从列表移除，不在此保留变更记录（改动历史见 git log）。
>
> 同一批改造里还新增了自定义 Provider(含原生 Anthropic Messages API 协议支持)。这是功能增补，不是本文档要精简的对象；`Anthropic` 的 usage 适配器（`src/providers/usage/anthropic.ts`）因此从死代码变为活代码，不再适用于"未接入协议应删除"的判断。

## 优先级总览

| 级别 | 待办 | 主要收益 |
| --- | --- | --- |
| B | 收缩或删除 `/usage/*` HTTP API | 减少无认证查询面 |
| G | 删除客户端自动安装流程 | 缩小 launcher 职责 |
| H | 重新评估 Pi 支持 | 减少未充分验证的客户端路径 |
| K | 同账号多实例请求协调 | 减少并发排队造成的感知延迟 |

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

Pi 目前通过普通 OpenAI-compatible environment 启动，但文档对其兼容性的描述偏强。本次自定义 Provider / 重试 / `--client-protocol` 等新增能力均未针对 Pi 单独设计或测试（Pi 走的是与 claude/codex 共享的底层代码路径，不会被破坏，但也没有专门验证）。

### 建议

- 如果没有明确活跃用户，直接从核心命令中移除 `pi`。
- 如果保留，应明确支持的 Pi 版本、验证范围和限制。
- 不应把 Pi 与经过专门 inline-provider 处理的 Codex 路径混同描述。

---

## K. 同账号多实例请求协调

来自一次真实的延迟排查（原文档已删除，结论摘录于此）：用户反馈"Claude Code 经 agentx 比直连慢很多"，数据分析显示单请求延迟经 agentx 实际更快，感知变慢的主因之一是**同一上游账号被多个独立 `agentx claude` 进程同时使用时相互排队**——每个进程都是独立的 adapter，互相之间没有协调，共享的是上游网关账号的限流/排队窗口。

### 现状

单进程内加请求队列解决不了这个问题，因为排队发生在**跨进程**层面。真正的修复需要基于 `provider + apiKey` 的本地跨进程协调机制（例如一个共享的本地锁文件或轻量协调服务），复杂度和"轻量级代理"的定位有明显张力。

### 建议

暂不实施。如果未来要做，优先做**诊断层面**的改进（检测到疑似排队特征时，给出比"响应变慢"更明确的提示，例如"检测到同一 provider 有其他 agentx 进程在运行"），而不是直接上跨进程协调机制。

---

## 建议下一批执行顺序

B 是当前唯一纯粹的"缩小攻击面"精简项，优先级最高。G 和 H 都是需要用户拍板的方向性选择（是保留便利功能、收窄支持范围，还是移除），不建议在没有明确意见的情况下单方面执行。K 已经结论为"暂不实施"，除非诊断层面的轻量方案被明确需要。
