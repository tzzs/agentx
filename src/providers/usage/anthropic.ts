import type { TokenUsage, UsageContext } from "../../usage/types.js";

/**
 * Anthropic Messages API usage fields: { input_tokens, output_tokens,
 * cache_*_tokens }. Takes the bare usage object, not a response envelope, so
 * the streaming pipes in src/streaming/common.ts can reuse this exact field
 * list to pull cache tokens out of a raw usage chunk.
 */
export function mapAnthropicUsage(usage: any, ctx: UsageContext): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const result: TokenUsage = {
    provider: ctx.provider ?? "unknown",
    model: ctx.model ?? "unknown",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    ...(ctx.timestamp === undefined ? {} : { timestamp: ctx.timestamp })
  };
  if (usage.cache_read_input_tokens !== undefined && usage.cache_read_input_tokens !== null) result.cachedInputTokens = Number(usage.cache_read_input_tokens);
  if (usage.cache_creation_input_tokens !== undefined && usage.cache_creation_input_tokens !== null) result.cacheWriteTokens = Number(usage.cache_creation_input_tokens);
  return result;
}

/** Anthropic Messages API usage: { usage: { input_tokens, output_tokens, cache_*_tokens } } */
export function extractAnthropicUsage(response: any, ctx: UsageContext): TokenUsage | null {
  return mapAnthropicUsage(response?.usage, ctx);
}
