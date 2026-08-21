import type { TokenUsage, UsageContext } from "../../usage/types.js";

/** Anthropic Messages API usage: { input_tokens, output_tokens, cache_*_tokens } */
export function extractAnthropicUsage(response: any, ctx: UsageContext): TokenUsage | null {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const cachedInput = usage.cache_read_input_tokens ?? usage.cache_creation_input_tokens;
  const result: TokenUsage = {
    provider: ctx.provider ?? "unknown",
    model: ctx.model ?? "unknown",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    ...(ctx.timestamp === undefined ? {} : { timestamp: ctx.timestamp }),
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId })
  };
  if (usage.cache_read_input_tokens !== undefined && usage.cache_read_input_tokens !== null) result.cachedInputTokens = Number(usage.cache_read_input_tokens);
  if (usage.cache_creation_input_tokens !== undefined && usage.cache_creation_input_tokens !== null) result.cacheWriteTokens = Number(usage.cache_creation_input_tokens);
  if (cachedInput !== undefined && cachedInput !== null && result.cachedInputTokens === undefined) result.cachedInputTokens = Number(cachedInput);
  return result;
}