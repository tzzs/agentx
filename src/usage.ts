import { providerById } from "./providers/registry.js";

export interface UsageResult {
  provider: string;
  supported: boolean;
  success: boolean;
  used?: number;
  remaining?: number;
  total?: number;
  unit?: string;
  resetAt?: string;
  message?: string;
}

export function parseDeepSeekBalance(payload: any): UsageResult {
  const balance = payload?.balance_infos?.[0];
  if (!balance) return { provider: "deepseek", supported: true, success: false, message: "DeepSeek returned no balance information." };
  return { provider: "deepseek", supported: true, success: true, remaining: Number(balance.total_balance ?? 0), total: Number(balance.total_balance ?? 0), unit: balance.currency ?? "CNY" };
}

export function parseOpenRouterKey(payload: any): UsageResult {
  const data = payload?.data ?? {};
  const used = Number(data.usage ?? 0); const limit = data.limit == null ? undefined : Number(data.limit); const remaining = data.limit_remaining == null ? limit === undefined ? undefined : limit - used : Number(data.limit_remaining);
  return { provider: "openrouter", supported: true, success: true, used, ...(limit === undefined ? {} : { total: limit }), ...(remaining === undefined ? {} : { remaining }), unit: "USD" };
}

export async function queryProviderUsage(providerId: string, apiKey: string): Promise<UsageResult> {
  if (providerId === "opencode") return { provider: providerId, supported: false, success: false, message: "OpenCode Go does not currently expose a documented public quota endpoint." };
  if (!apiKey) return { provider: providerId, supported: true, success: false, message: "Provider API key is missing." };
  const endpoint = providerId === "deepseek" ? "https://api.deepseek.com/user/balance" : providerId === "openrouter" ? "https://openrouter.ai/api/v1/key" : undefined;
  if (!endpoint) throw new Error(`Usage query is not implemented for provider "${providerId}".`);
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { provider: providerId, supported: true, success: false, message: payload?.error?.message ?? `Provider returned HTTP ${response.status}.` };
  return providerId === "deepseek" ? parseDeepSeekBalance(payload) : parseOpenRouterKey(payload);
}

export function usageProvider(id?: string) { return providerById(id ?? process.env.AGENTX_PROVIDER ?? "opencode"); }
