import type { TokenUsage, UsageContext } from "../../usage/types.js";

function base(usage: any, ctx: UsageContext): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  return {
    provider: ctx.provider ?? "unknown",
    model: ctx.model ?? "unknown",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    ...(ctx.timestamp === undefined ? {} : { timestamp: ctx.timestamp }),
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId })
  };
}

/** OpenAI Responses API usage: { input_tokens, output_tokens, ... } */
export function extractResponsesUsage(response: any, ctx: UsageContext): TokenUsage | null {
  const usage = response?.usage;
  const result = base(usage, ctx);
  if (!result) return null;
  result.inputTokens = Number(usage.input_tokens ?? 0);
  result.outputTokens = Number(usage.output_tokens ?? 0);
  result.totalTokens = Number(usage.total_tokens ?? (result.inputTokens + result.outputTokens));
  const cached = usage.input_tokens_details?.cached_tokens;
  if (cached !== undefined && cached !== null) result.cachedInputTokens = Number(cached);
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && reasoning !== null) result.reasoningTokens = Number(reasoning);
  return result;
}

/** OpenAI Chat Completions usage: { prompt_tokens, completion_tokens, ... } */
export function extractChatUsage(response: any, ctx: UsageContext): TokenUsage | null {
  const usage = response?.usage;
  const result = base(usage, ctx);
  if (!result) return null;
  result.inputTokens = Number(usage.prompt_tokens ?? 0);
  result.outputTokens = Number(usage.completion_tokens ?? 0);
  result.totalTokens = Number(usage.total_tokens ?? (result.inputTokens + result.outputTokens));
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined && cached !== null) result.cachedInputTokens = Number(cached);
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && reasoning !== null) result.reasoningTokens = Number(reasoning);
  return result;
}