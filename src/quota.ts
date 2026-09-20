import { jsonRecord, recCount, recObj, recStr, recObjs } from "./json.js";
import type { JsonRecord } from "./json.js";
import { providerById } from "./providers/registry.js";
import { resolveCredential } from "./credentials.js";

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

export function parseDeepSeekBalance(payload: JsonRecord): UsageResult {
  const balance = recObjs(payload, "balance_infos")[0];
  if (!balance) return { provider: "deepseek", supported: true, success: false, message: "DeepSeek returned no balance information." };
  return { provider: "deepseek", supported: true, success: true, remaining: recCount(balance, "total_balance") ?? 0, unit: recStr(balance, "currency") ?? "CNY" };
}

export function parseOpenRouterKey(payload: JsonRecord): UsageResult {
  const data = recObj(payload, "data") ?? {};
  const used = recCount(data, "usage") ?? 0;
  const limit = recCount(data, "limit");
  const remaining = recCount(data, "limit_remaining") ?? (limit === undefined ? undefined : limit - used);
  return { provider: "openrouter", supported: true, success: true, used, ...(limit === undefined ? {} : { total: limit }), ...(remaining === undefined ? {} : { remaining }), unit: "USD" };
}

export async function queryProviderUsage(providerId: string, apiKey: string): Promise<UsageResult> {
  const provider = providerById(providerId);
  const endpoint = provider.quota?.endpoint;
  if (!endpoint) return { provider: providerId, supported: false, success: false, message: `${provider.name} does not currently expose a documented public quota endpoint.` };
  if (!apiKey) return { provider: providerId, supported: true, success: false, message: "Provider API key is missing." };
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return { provider: providerId, supported: true, success: false, message: `Failed to reach ${providerId}: ${error instanceof Error ? error.message : error}` };
  }
  const payload = jsonRecord(await response.json().catch(() => ({})));
  if (!response.ok) return { provider: providerId, supported: true, success: false, message: recStr(recObj(payload, "error"), "message") ?? `Provider returned HTTP ${response.status}.` };
  return providerId === "deepseek" ? parseDeepSeekBalance(payload) : parseOpenRouterKey(payload);
}

function usageProvider(id?: string) { return providerById(id ?? process.env.AGENTX_PROVIDER ?? "opencode"); }

/** Resolve credentials, query quota, and format the result; shared by `agentx quota` and the deprecated `agentx usage --provider`. */
export async function runQuotaCommand(providerId: string | undefined): Promise<{ output: string; exitCode: number }> {
  const provider = usageProvider(providerId);
  const key = provider.id === "opencode" ? "" : await resolveCredential(provider);
  const result = await queryProviderUsage(provider.id, key);
  return { output: JSON.stringify(result, null, 2), exitCode: !result.success && result.supported ? 1 : 0 };
}
