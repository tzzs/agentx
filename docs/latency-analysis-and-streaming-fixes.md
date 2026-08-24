# 延迟问题分析与流式优化记录

> 背景：用户反馈「Claude Code 经 agentx 使用相同模型（ox-alpha-free）比 OpenCode 直连慢特别多」。
> 本文档记录基于真实会话数据的分析结论，以及据此实施的流式转换优化。

## 一、数据来源

| 数据源 | 内容 |
|---|---|
| `~/.claude/projects/-home-tanzz-workspaces-dsh-git-workspace-catshark/*.jsonl` | Claude Code（经 agentx）会话，332 个请求 |
| `opencode.db`（`session`/`message` 表） | OpenCode 直连同工作区会话，739 个请求，同模型 |
| `~/.config/agentx/usage.db` | agentx 侧每请求 token 与缓存命中记录 |

## 二、关键发现（与直觉相反）

| 指标 | CC 经 agentx | OpenCode 直连 |
|---|---|---|
| 单请求延迟 | p50 ≈ 8s；微小请求（输出 <150 tok）中位 **4.5s**；固定开销拟合 ≈6s；流式 ~45 tok/s | p50 ≈ 19s；微小请求中位 **12.4s**；固定开销 ≈26s |
| 上游缓存命中 | **94%** 正常工作 | 93% |

**单请求速度经 agentx 并不慢，甚至更快。**「慢特别多」的感受由以下因素叠加：

1. **多实例并发**：8/25 凌晨 02:14–03:22 同时运行 3 个 CC 会话（两个 `effort=xhigh`），共享同一网关账号互相排队。
2. **思考期"假死"**：agentx 原实现丢弃上游全部 reasoning 流（src/streaming.ts 只转发 `output_text.delta` 与 function_call），推理模型长思考期间 CC 界面完全静止——首块可见输出 p50 7.5s、**p90 32s**，最慢单请求 256s（约 1.2 万隐藏思考 token）。OpenCode 实时渲染 reasoning 流，等待相同但"看起来在动"。
3. **步子更碎**：CC 平均每请求仅 977 输出 token（单次一个工具调用），同类任务请求数约为 OpenCode 的 1.7 倍，每次都付排队 + TTFT。
4. **缓存字段丢失造成误判**：回传 usage 未映射 `cached_tokens`，CC 日志恒显 `cache_read=0`，让人误以为缓存未命中（实测命中率 94%）。另：8/22 晚曾出现 37 个请求 0% 缓存命中的时段，属历史问题。

## 三、已实施优化

### Claude Code 路径 — `pipeResponsesStream`（src/streaming.ts）

- **思考流式转发**：上游 `reasoning_summary_text.delta` / `reasoning_text.delta`（Responses 协议）、`delta.reasoning_content` / `delta.reasoning`（Chat 协议）→ Anthropic `thinking` 内容块（`content_block_start` + `thinking_delta`）；文本/工具块开始前自动闭合思考块。
- **缓存字段映射**：`message_start` / `message_delta` 的 usage 补上 `cache_read_input_tokens`（源自 `input_tokens_details.cached_tokens`）。同时修复 Chat 上游最终 chunk 顶层 `usage` 此前完全未被读取的缺陷。
- 注意：转发给 CC 的 thinking 块无 Anthropic 签名（上游非 Anthropic 无法提供），仅用于本地展示。

### Codex 路径 — `pipeChatStreamToResponses` / `pipeResponsesPassthrough`

- Chat 上游 reasoning → 标准 Responses reasoning 事件序列：`response.output_item.added` → `reasoning_summary_part.added` → `reasoning_summary_text.delta/done` → `output_item.done`，Codex 客户端可实时显示思考。合成 reasoning item 使用固定高 `output_index`（1000），避免与 text(0)/tool index 冲突。
- passthrough 原样透传字节，无需处理 reasoning；仅补 usage 捕获。
- 两条管道的 usage 捕获均补齐 `cachedInputTokens` / `reasoningTokens`（usage.db 可记录准确缓存命中）。

### 心跳保活（三条管道通用）

15s 间隔写入 SSE 注释 `: keep-alive\n\n`（timer `unref()`，finally 中清理），长 TTFT / 长思考期间客户端与中间代理不再因静默超时断连。

### 非流式路径

- `providers.ts:fromResponsesResponse`：补 `cache_read_input_tokens`；reasoning summary 合成为 `thinking` 块。
- `catalog.ts:fromChatResponse`：`reasoning_content` → thinking 块 + 缓存字段。
- `catalog.ts:fromChatResponseToResponses`：合成 reasoning item + `input_tokens_details` / `output_tokens_details`。

### 请求侧剥离 thinking

Claude Code 会将 thinking 块回显进后续请求。src/providers.ts 的 `toResponsesInput` 现已过滤 `thinking` / `redacted_thinking` 部分，避免未知 item 类型泄漏到上游（chat 路径原本即忽略未知块）。

## 四、验证与遗留建议

- 新增/更新测试覆盖：thinking 映射与闭合顺序、Codex reasoning 事件序列、缓存/思考 token 记录、请求侧剥离；`npm test` 全部通过（101 个）。
- 遗留建议：
  - 避免同账号并发多实例（排队是当晚卡顿主因之一），必要时在 agentx 内做请求排队；
  - 若后续接入支持签名的上游，可为 thinking 块补签名以兼容更严格的客户端校验。
