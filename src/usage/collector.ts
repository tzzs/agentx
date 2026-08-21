import type { TokenUsage, TokenUsageRow, UsageStore } from "./types.js";

export function normalizeUsage(usage: TokenUsage): TokenUsageRow {
  const inputTokens = Number(usage.inputTokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? 0);
  const now = usage.timestamp ?? Date.now();
  return {
    provider: usage.provider,
    model: usage.model,
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.totalTokens ?? (inputTokens + outputTokens)),
    cachedTokens: Number(usage.cachedInputTokens ?? 0),
    reasoningTokens: Number(usage.reasoningTokens ?? 0),
    estimated: Boolean(usage.estimated),
    sessionId: usage.sessionId ?? null,
    createdAt: now
  };
}

export class TokenUsageCollector {
  constructor(private readonly store: UsageStore) {}

  async record(usage: TokenUsage): Promise<void> {
    if (!usage.provider || !usage.model) return;
    await this.store.record(normalizeUsage(usage));
  }

  async close(): Promise<void> { await this.store.close(); }
}
