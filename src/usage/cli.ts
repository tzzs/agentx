import { calculateCost } from "./pricing/index.js";
import { defaultUsageStore } from "./storage.js";
import type { ModelUsageStat, UsagePeriod, UsageTotals } from "./types.js";

export function loadStatsStore(): Promise<Awaited<ReturnType<typeof defaultUsageStore>>> {
  return defaultUsageStore();
}

export function formatPeriod(period: UsagePeriod): string {
  return { today: "Today", week: "This week", month: "This month", all: "All time" }[period];
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

export function renderUsageStats(stats: { models: ModelUsageStat[]; totals: UsageTotals; period: UsagePeriod }): string {
  const lines: string[] = [];
  lines.push(`Token Usage (${formatPeriod(stats.period)})`, "");
  if (!stats.models.length) { lines.push("No usage recorded yet."); return lines.join("\n"); }
  const providerWidth = Math.max(...stats.models.map((item) => item.provider.length), "Provider".length);
  const modelWidth = Math.max(...stats.models.map((item) => item.model.length), "Model".length);
  lines.push(`${"Provider".padEnd(providerWidth)}  ${"Model".padEnd(modelWidth)}  Tokens  Requests  Cost`);
  for (const item of stats.models) {
    const cost = calculateCost(item.provider, item.model, { provider: item.provider, model: item.model, inputTokens: 0, outputTokens: item.tokens, totalTokens: item.tokens });
    lines.push(`${item.provider.padEnd(providerWidth)}  ${item.model.padEnd(modelWidth)}  ${compact(item.tokens).padStart(6)}  ${String(item.requests).padStart(8)}  $${cost.toFixed(4)}`);
  }
  lines.push("");
  lines.push(`Input:  ${compact(stats.totals.inputTokens)}`);
  lines.push(`Output: ${compact(stats.totals.outputTokens)}`);
  lines.push(`Total:  ${compact(stats.totals.totalTokens)}`);
  return lines.join("\n");
}

export async function runUsageStats(period: UsagePeriod = "all"): Promise<string> {
  const store = await loadStatsStore();
  try {
    const [models, totals] = await Promise.all([store.modelStats(period), store.totals(period)]);
    return renderUsageStats({ models, totals, period });
  } finally { await store.close(); }
}