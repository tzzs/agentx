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
    ...(ctx.timestamp === undefined ? {} : { timestamp: ctx.timestamp })
  };
}

/**
 * Shared field mapping for both OpenAI wire formats; the Responses and Chat
 * Completions APIs differ only in their usage field names. Operates on the
 * bare `usage` object (not the response envelope) so the streaming pipes in
 * src/streaming/common.ts can reuse the exact same field list to pull
 * cache/reasoning tokens out of a raw usage chunk, instead of keeping a
 * second, independently-maintained copy of these field names.
 */
function mapUsage(usage: any, ctx: UsageContext, names: {
  input: string; output: string; cached: string; reasoning: string;
}): TokenUsage | null {
  const result = base(usage, ctx);
  if (!result) return null;
  result.inputTokens = Number(usage[names.input] ?? 0);
  result.outputTokens = Number(usage[names.output] ?? 0);
  result.totalTokens = Number(usage.total_tokens ?? (result.inputTokens + result.outputTokens));
  const cached = usage[names.cached]?.cached_tokens;
  if (cached !== undefined && cached !== null) result.cachedInputTokens = Number(cached);
  const reasoning = usage[names.reasoning]?.reasoning_tokens;
  if (reasoning !== undefined && reasoning !== null) result.reasoningTokens = Number(reasoning);
  return result;
}

/** OpenAI Responses API usage fields: { input_tokens, output_tokens, ... }. Takes the bare usage object, not a response envelope. */
export function mapResponsesUsage(usage: any, ctx: UsageContext): TokenUsage | null {
  return mapUsage(usage, ctx, { input: "input_tokens", output: "output_tokens", cached: "input_tokens_details", reasoning: "output_tokens_details" });
}

/** OpenAI Chat Completions usage fields: { prompt_tokens, completion_tokens, ... }. Takes the bare usage object, not a response envelope. */
export function mapChatUsage(usage: any, ctx: UsageContext): TokenUsage | null {
  return mapUsage(usage, ctx, { input: "prompt_tokens", output: "completion_tokens", cached: "prompt_tokens_details", reasoning: "completion_tokens_details" });
}

/** OpenAI Responses API usage: { input_tokens, output_tokens, ... } */
export function extractResponsesUsage(response: any, ctx: UsageContext): TokenUsage | null {
  return mapResponsesUsage(response?.usage, ctx);
}

/** OpenAI Chat Completions usage: { prompt_tokens, completion_tokens, ... } */
export function extractChatUsage(response: any, ctx: UsageContext): TokenUsage | null {
  return mapChatUsage(response?.usage, ctx);
}
