export interface TokenUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  requestId?: string;
  timestamp?: number;
  sessionId?: string;
  estimated?: boolean;
}

export interface UsageContext {
  provider?: string;
  model?: string;
  sessionId?: string;
  timestamp?: number;
  requestId?: string;
}

export type UsagePeriod = "today" | "week" | "month" | "all";

export interface TokenUsageRow {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
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
  tokens: number;
  requests: number;
}

export interface ProviderCapabilities {
  supportsUsage: boolean;
  supportsStreamingUsage: boolean;
  supportsCacheTokens: boolean;
}

export interface ProviderUsageAdapter {
  extractUsage(response: any): TokenUsage | null;
}

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