export interface TokenUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  timestamp?: number;
  sessionId?: string;
  estimated?: boolean;
}

export interface UsageContext {
  provider?: string;
  model?: string;
  sessionId?: string;
  timestamp?: number;
}

export type UsagePeriod = "today" | "week" | "month" | "all";

export interface TokenUsageRow {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimated: boolean;
  sessionId: string | null;
  createdAt: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderUsageStat {
  provider: string;
  tokens: number;
  requests: number;
}

export interface ModelUsageStat {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  tokens: number;
  requests: number;
}

export type { ProviderCapabilities } from "../providers/types.js";

export interface PricingProvider {
  calculate(model: string, usage: TokenUsage): number;
}

export interface UsageStore {
  record(row: TokenUsageRow): Promise<void>;
  sessionTotals(sessionId: string): Promise<UsageTotals>;
  providerStats(period?: UsagePeriod): Promise<ProviderUsageStat[]>;
  modelStats(period?: UsagePeriod): Promise<ModelUsageStat[]>;
  totals(period?: UsagePeriod): Promise<UsageTotals>;
  close(): Promise<void>;
}
