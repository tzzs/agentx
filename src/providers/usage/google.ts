import type { TokenUsage, UsageContext } from "../../usage/types.js";

/** Google Gemini usageMetadata: { promptTokenCount, candidatesTokenCount, ... } */
export function extractGeminiUsage(response: any, ctx: UsageContext): TokenUsage | null {
  const usage = response?.usageMetadata;
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.promptTokenCount ?? 0);
  const outputTokens = Number(usage.candidatesTokenCount ?? 0);
  const result: TokenUsage = {
    provider: ctx.provider ?? "unknown",
    model: ctx.model ?? "unknown",
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.totalTokenCount ?? (inputTokens + outputTokens)),
    ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }),
    ...(ctx.timestamp === undefined ? {} : { timestamp: ctx.timestamp }),
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId })
  };
  if (usage.cachedContentTokenCount !== undefined && usage.cachedContentTokenCount !== null) result.cachedInputTokens = Number(usage.cachedContentTokenCount);
  if (usage.thoughtsTokenCount !== undefined && usage.thoughtsTokenCount !== null) result.reasoningTokens = Number(usage.thoughtsTokenCount);
  return result;
}