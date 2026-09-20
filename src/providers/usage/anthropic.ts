import type { TokenUsage, UsageContext } from "../../usage/types.js";
import type { JsonRecord } from "../../json.js";
import { recCount, recObj } from "../../json.js";

/**
 * Anthropic Messages API usage fields: { input_tokens, output_tokens,
 * cache_*_tokens }. Takes the bare usage object, not a response envelope, so
 * the streaming pipes in src/streaming/common.ts can reuse this exact field
 * list to pull cache tokens out of a raw usage chunk.
 */
export function mapAnthropicUsage(usage: JsonRecord | undefined, ctx: UsageContext): TokenUsage | null {
  if (!usage) return null;
  const inputTokens = recCount(usage, "input_tokens") ?? 0;
  const outputTokens = recCount(usage, "output_tokens") ?? 0;
  const cachedInputTokens = recCount(usage, "cache_read_input_tokens");
  const cacheWriteTokens = recCount(usage, "cache_creation_input_tokens");
  return {
    provider: ctx.provider ?? "unknown",
    model: ctx.model ?? "unknown",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    ...(ctx.timestamp === undefined ? {} : { timestamp: ctx.timestamp }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  };
}

/** Anthropic Messages API usage: { usage: { input_tokens, output_tokens, cache_*_tokens } } */
export function extractAnthropicUsage(response: JsonRecord, ctx: UsageContext): TokenUsage | null {
  return mapAnthropicUsage(recObj(response, "usage"), ctx);
}
