import type { ProviderDefinition, ProviderModel } from "./types.js";

const openCodeBase = "https://opencode.ai/zen/go/v1";
const deepSeekBase = "https://api.deepseek.com/v1";
const openRouterBase = "https://openrouter.ai/api/v1";
/** OpenCode's public model registry; carries real context/output limits the Zen list omits. */
const modelsDevUrl = "https://models.dev/api.json";
/** OpenRouter's auth-free catalog; backfills the models models.dev does not list. */
const openRouterModelsUrl = `${openRouterBase}/models`;

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

/** Flatten OpenRouter's public model list into a single table keyed by its vendor-prefixed id. */
function parseOpenRouterMetadata(payload: any): MetadataMap {
  const table: MetadataMap = new Map();
  for (const entry of ((payload?.data ?? []) as Array<any>)) {
    if (!entry?.id) continue;
    const input = (entry?.architecture?.input_modalities ?? []).filter((item: unknown) => item === "text" || item === "image");
    const meta: ModelMetadata = {
      ...(Number.isFinite(entry?.context_length) ? { contextWindow: Number(entry.context_length) } : {}),
      ...(Number.isFinite(entry?.top_provider?.max_completion_tokens) ? { maxOutputTokens: Number(entry.top_provider.max_completion_tokens) } : {}),
      ...(input.length ? { modalities: input } : {}),
    };
    if (Object.keys(meta).length) table.set(entry.id, meta);
  }
  return table;
}

/**
 * Resolve a model's metadata: exact id first, then a unique trailing-segment
 * match against vendor-prefixed ids ("vendor/model"); ambiguous suffixes
 * resolve to nothing rather than risk misattribution.
 */
function lookupMetadata(table: MetadataMap | undefined, id: string): ModelMetadata | undefined {
  if (!table) return undefined;
  const exact = table.get(id);
  if (exact) return exact;
  let match: ModelMetadata | undefined;
  for (const [key, value] of table) {
    if (!key.includes("/") || key.slice(key.lastIndexOf("/") + 1) !== id) continue;
    if (match) return undefined;
    match = value;
  }
  return match;
}

/** Fill gaps only: explicit registry config wins, then models.dev, then OpenRouter. */
function applyModelMetadata(model: ProviderModel, primary?: MetadataMap, secondary?: MetadataMap): ProviderModel {
  const first = lookupMetadata(primary, model.model);
  const second = lookupMetadata(secondary, model.model);
  const contextWindow = model.contextWindow ?? first?.contextWindow ?? second?.contextWindow;
  const maxOutputTokens = model.maxOutputTokens ?? first?.maxOutputTokens ?? second?.maxOutputTokens;
  const modalities = model.modalities ?? first?.modalities ?? second?.modalities;
  if (contextWindow === model.contextWindow && maxOutputTokens === model.maxOutputTokens && modalities === model.modalities) return model;
  return { ...model, contextWindow, maxOutputTokens, modalities };
}

/** Last-fetched public catalogs, reused to enrich custom (non-registry) model ids. */
let cachedOpenRouter: MetadataMap = new Map();
let cachedSections: MetadataSections = new Map();

/**
 * Enrich a synthetic (custom id) entry from the last-fetched OpenRouter /
 * models.dev catalogs. Unknown ids keep their unset fields, which the Codex
 * catalog writer replaces with conservative defaults.
 */
export function withExternalMetadata(model: ProviderModel): ProviderModel {
  return applyModelMetadata(model, cachedOpenRouter, cachedSections.get(model.provider));
}

/**
 * Fill missing limits on registry entries from their provider's section,
 * falling back further to OpenRouter's public catalog. Explicitly configured
 * values always win; unmatched ids keep safe defaults.
 *
 * Implicit contract: each registry provider id must equal the models.dev
 * top-level section key it should draw metadata from ("opencode",
 * "deepseek", "openrouter"). A renamed id silently loses metadata and falls
 * back to defaults — update one when renaming the other.
 */
function applyMetadataToRegistry(sections: MetadataSections, openRouter: MetadataMap): void {
  for (const provider of providerRegistry) {
    provider.models = provider.models.map((model) => applyModelMetadata(model, sections.get(provider.id), openRouter));
  }
  allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
}

function models(provider: string, endpoint: string, ids: string[], protocol: "responses" | "chat-completions") { return ids.map((model) => ({ provider, model, protocol, endpoint })); }

function openCodeModels(ids: string[], devMetadata?: MetadataMap, routerMetadata?: MetadataMap): ProviderModel[] {
  const ordered = [...ids].sort((a, b) => Number(responsesModelIds.has(b)) - Number(responsesModelIds.has(a)));
  return ordered.map((model) => applyModelMetadata({
    provider: "opencode",
    model,
    protocol: responsesModelIds.has(model) ? "responses" : "chat-completions",
    endpoint: responsesModelIds.has(model) ? `${openCodeBase}/responses` : `${openCodeBase}/chat/completions`,
  }, devMetadata, routerMetadata));
}

export const providerRegistry: ProviderDefinition[] = [
  { id: "opencode", name: "OpenCode", apiKeyEnv: "OPENCODE_API_KEY", capabilities: { supportsUsage: true, supportsStreamingUsage: true, supportsCacheTokens: true }, models: openCodeModels(fallbackOpenCodeIds) },
  { id: "deepseek", name: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", capabilities: { supportsUsage: true, supportsStreamingUsage: true, supportsCacheTokens: true }, models: models("deepseek", `${deepSeekBase}/chat/completions`, ["deepseek-v4-pro", "deepseek-v4-flash"], "chat-completions") },
  { id: "openrouter", name: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", capabilities: { supportsUsage: true, supportsStreamingUsage: true, supportsCacheTokens: false }, models: models("openrouter", `${openRouterBase}/chat/completions`, [process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini"], "chat-completions") }
];

export const allModels = providerRegistry.flatMap((provider) => provider.models);

/**
 * Refresh provider model catalogs. OpenCode's list is fetched only when the
 * runtime is unbound or pinned to OpenCode. Metadata is fetched only when a
 * Codex catalog will be generated; it is applied globally because Codex can
 * enumerate multiple providers through the local proxy. Each source tolerates
 * independent failure and mutations stay in place for existing references.
 */
export async function refreshProviderCatalog(
  options: { provider?: string; metadata?: boolean } = {},
  fetcher: typeof fetch = fetch,
): Promise<{ list: boolean; metadata: boolean }> {
  const needList = !options.provider || options.provider === "opencode";
  const needMetadata = Boolean(options.metadata);
  if (!needList && !needMetadata) return { list: false, metadata: false };

  const [list, sections, openRouter] = await Promise.all([
    needList
      ? fetcher(`${openCodeBase}/models`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) })
          .then((response) => (response.ok ? response.json() : null)).catch(() => null)
      : Promise.resolve(null),
    needMetadata
      ? fetcher(modelsDevUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) })
          .then((response) => (response.ok ? response.json() : null)).then(parseModelsDevMetadata)
          .catch((): MetadataSections => new Map())
      : Promise.resolve(new Map()),
    needMetadata
      ? fetcher(openRouterModelsUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) })
          .then((response) => (response.ok ? response.json() : null)).then(parseOpenRouterMetadata)
          .catch((): MetadataMap => new Map())
      : Promise.resolve(new Map()),
  ]) as [any, MetadataSections, MetadataMap];

  let refreshedMetadata = false;
  if (needMetadata) {
    cachedOpenRouter = openRouter;
    cachedSections = sections;
    if (sections.size || openRouter.size) {
      applyMetadataToRegistry(sections, openRouter);
      refreshedMetadata = true;
    }
  }

  let refreshedList = false;
  if (!list) return { list: false, metadata: refreshedMetadata };
  const ids = ((list.data ?? []) as Array<{ id?: string }>).map((item) => item.id).filter((id): id is string => Boolean(id));
  if (ids.length) {
    const openCode = providerRegistry.find((provider) => provider.id === "opencode");
    if (openCode) {
      openCode.models = openCodeModels(ids, sections.get("opencode"), openRouter);
      allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
      refreshedList = true;
    }
  }
  return { list: refreshedList, metadata: refreshedMetadata };
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
