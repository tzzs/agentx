import type { ProviderDefinition, ProviderModel } from "./types.js";

const openCodeBase = "https://opencode.ai/zen/go/v1";
const deepSeekBase = "https://api.deepseek.com/v1";
const openRouterBase = "https://openrouter.ai/api/v1";
/** OpenCode's public model registry; carries real context/output limits the Zen list omits. */
const modelsDevUrl = "https://models.dev/api.json";

/** Static fallback catalog used until the OpenCode model list can be fetched. */
const fallbackOpenCodeIds = ["gpt-5.6-luna", "deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3", "minimax-m2.7", "minimax-m2.5", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "glm-5.2", "glm-5.3", "glm-5.1", "glm-5", "mimo-v2.5-pro", "mimo-v2.5", "hy3"];

/** OpenCode models served through the Responses API rather than Chat Completions. */
const responsesModelIds = new Set(["gpt-5.6-luna"]);

interface ModelMetadata { contextWindow?: number; maxOutputTokens?: number; modalities?: string[] }

/** Per-provider metadata tables keyed by models.dev section id then model id. */
type MetadataSections = Map<string, MetadataMap>;
type MetadataMap = Map<string, ModelMetadata>;

function parseModelsDevMetadata(payload: any): MetadataSections {
  const sections: MetadataSections = new Map();
  for (const [sectionId, definition] of Object.entries((payload ?? {}) as Record<string, any>)) {
    const table: MetadataMap = new Map();
    for (const [id, entry] of Object.entries(definition?.models ?? {}) as Array<[string, any]>) {
      const input = (entry?.modalities?.input ?? []).filter((item: unknown) => item === "text" || item === "image");
      table.set(id, {
        ...(Number.isFinite(entry?.limit?.context) ? { contextWindow: Number(entry.limit.context) } : {}),
        ...(Number.isFinite(entry?.limit?.output) ? { maxOutputTokens: Number(entry.limit.output) } : {}),
        ...(input.length ? { modalities: input } : {}),
      });
    }
    if (table.size) sections.set(sectionId, table);
  }
  return sections;
}

/**
 * Fill missing limits on registry entries from their provider's section.
 * Explicitly configured values always win; unmatched ids keep safe defaults.
 */
function applyMetadataToRegistry(sections: MetadataSections): void {
  for (const provider of providerRegistry) {
    const table = sections.get(provider.id);
    if (!table) continue;
    provider.models = provider.models.map((model) => {
      const meta = table.get(model.model);
      if (!meta) return model;
      return {
        ...model,
        contextWindow: model.contextWindow ?? meta.contextWindow,
        maxOutputTokens: model.maxOutputTokens ?? meta.maxOutputTokens,
        modalities: model.modalities ?? meta.modalities,
      };
    });
  }
  allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
}

function models(provider: string, endpoint: string, ids: string[], protocol: "responses" | "chat-completions") { return ids.map((model) => ({ provider, model, protocol, endpoint })); }

function openCodeModels(ids: string[], metadata: MetadataMap = new Map()): ProviderModel[] {
  const ordered = [...ids].sort((a, b) => Number(responsesModelIds.has(b)) - Number(responsesModelIds.has(a)));
  return ordered.map((model) => ({
    provider: "opencode",
    model,
    protocol: responsesModelIds.has(model) ? "responses" : "chat-completions",
    endpoint: responsesModelIds.has(model) ? `${openCodeBase}/responses` : `${openCodeBase}/chat/completions`,
    ...metadata.get(model),
  })) as ProviderModel[];
}export const providerRegistry: ProviderDefinition[] = [
  { id: "opencode", name: "OpenCode", apiKeyEnv: "OPENCODE_API_KEY", capabilities: { supportsUsage: true, supportsStreamingUsage: true, supportsCacheTokens: true }, models: openCodeModels(fallbackOpenCodeIds) },
  { id: "deepseek", name: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", capabilities: { supportsUsage: true, supportsStreamingUsage: true, supportsCacheTokens: true }, models: models("deepseek", `${deepSeekBase}/chat/completions`, ["deepseek-v4-pro", "deepseek-v4-flash"], "chat-completions") },
  { id: "openrouter", name: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", capabilities: { supportsUsage: true, supportsStreamingUsage: true, supportsCacheTokens: false }, models: models("openrouter", `${openRouterBase}/chat/completions`, [process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini"], "chat-completions") }
];

export const allModels = providerRegistry.flatMap((provider) => provider.models);

/**
 * Refresh the OpenCode model catalog from the upstream `/v1/models` endpoint,
 * enriching every provider's entries with real limits from OpenCode's public
 * registry (models.dev) in parallel. The two fetches tolerate failure
 * independently: without the list the static fallback stays, and metadata is
 * applied to all providers — including static ones — whenever it arrives.
 * Mutates the registry in place so existing references stay valid.
 */
export async function refreshOpenCodeModels(fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const [list, sections] = await Promise.all([
      fetcher(`${openCodeBase}/models`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
      fetcher(modelsDevUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) }).then((response) => (response.ok ? response.json() : null)).then(parseModelsDevMetadata).catch((): MetadataSections => new Map()),
    ]) as [any, MetadataSections];
    if (sections.size) applyMetadataToRegistry(sections);
    if (!list) return false;
    const ids = ((list.data ?? []) as Array<{ id?: string }>).map((item) => item.id).filter((id): id is string => Boolean(id));
    if (!ids.length) return false;
    const openCode = providerRegistry.find((provider) => provider.id === "opencode");
    if (!openCode) return false;
    openCode.models = openCodeModels(ids, sections.get("opencode"));
    allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
    return true;
  } catch {
    return false;
  }
}

export function providerFor(model: string, providerId?: string): ProviderModel {
  const candidates = providerId ? allModels.filter((item) => item.provider === providerId) : allModels;
  const match = candidates.find((item) => item.model === model) ?? (providerId === "openrouter" ? candidates[0] && { ...candidates[0], model } : undefined);
  if (!match) throw new Error(`Model "${model}" is not available. Available models: ${candidates.map((item) => `${item.provider}/${item.model}`).join(", ")}`);
  return match;
}

export function providerById(id: string) { const provider = providerRegistry.find((item) => item.id === id); if (!provider) throw new Error(`Provider "${id}" is not configured.`); return provider; }
/** Display name for logging / user-facing errors; falls back to the raw id. */
export function providerDisplayName(id: string): string { try { return providerById(id).name; } catch { return id; } }

/**
 * Credentials are environment-only. The AgentX-prefixed variable is canonical
 * so it never clashes with variables users set for other tools; the provider's
 * plain variable stays supported so an already-configured key works directly.
 */
export function credentialEnvName(provider: ProviderDefinition): string { return `AGENTX_${provider.apiKeyEnv}`; }

export function apiKeyFor(model: ProviderModel, override?: string) {
  if (override) return override;
  const provider = providerById(model.provider);
  return process.env[credentialEnvName(provider)] || process.env[provider.apiKeyEnv] || "";
}
