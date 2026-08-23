import type { PricingProvider, TokenUsage } from "../types.js";

export interface RateTable {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
  reasoningPerMillion?: number;
}

export function makePricingProvider(rates: RateTable, overrides: Record<string, Partial<RateTable>> = {}): PricingProvider {
  return {
    calculate(model: string, usage: TokenUsage): number {
      const table = { ...rates, ...(overrides[model] ?? {}) };
      const perMillion = (value: number | undefined, rate: number | undefined) => (value ?? 0) / 1_000_000 * (rate ?? 0);
      // Cached input is a subset of inputTokens in every provider's usage
      // semantics; bill only the uncached remainder at the full input rate.
      const uncachedInput = Math.max(0, usage.inputTokens - (usage.cachedInputTokens ?? 0));
      return perMillion(uncachedInput, table.inputPerMillion)
        + perMillion(usage.outputTokens, table.outputPerMillion)
        + perMillion(usage.cachedInputTokens, table.cachedInputPerMillion)
        + perMillion(usage.cacheWriteTokens, table.cacheWritePerMillion)
        + perMillion(usage.reasoningTokens, table.reasoningPerMillion);
    }
  };
}
