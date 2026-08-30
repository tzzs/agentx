import type { ProviderDefinition, ProviderModel } from "./types.js";
import { loadOpenCodeModels, loadOpenRouterModels, saveOpenCodeModels, saveOpenRouterModels } from "../runtime.js";

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

/** How long a persisted OpenCode catalog snapshot stays fresh enough to skip a live refetch. */
const OPENCODE_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * DeepSeek's long-context ids are OpenCode's own branding — the same two ids
 * are served both through OpenCode's gateway and through the direct DeepSeek
 * provider — so models.dev/OpenRouter never carry a matching entry for either
 * listing. Without an explicit override Codex's generated catalog falls back
 * to a conservative 131072 (see codex-catalog.ts), auto-compacting long
 * DeepSeek sessions far earlier than necessary — the same under-declaration
 * CLAUDE_CODE_MAX_CONTEXT_TOKENS fixes for Claude Code in process.ts. This is
 * also the single source of truth for "is this id DeepSeek's long-context
 * model" elsewhere in the codebase (catalog.ts's chat-completions dialect
 * check, process.ts's Claude Code context declaration) — both call
 * `isDeepSeekLongContextModel` instead of keeping their own copy of the
 * pattern, which used to also match a vendor-prefixed ("vendor/deepseek-v4-pro")
 * or `[1m]`-suffixed id; the pattern preserves that.
 */
const DEEPSEEK_LONG_CONTEXT_PATTERN = /(?:^|\/)deepseek-v4-(?:flash|pro)(?:\[1m\])?$/;
const DEEPSEEK_LONG_CONTEXT_WINDOW = 1_000_000;
export function isDeepSeekLongContextModel(model: string): boolean {
  return DEEPSEEK_LONG_CONTEXT_PATTERN.test(model);
}
function deepSeekLongContextWindow(model: string): number | undefined {
  return isDeepSeekLongContextModel(model) ? DEEPSEEK_LONG_CONTEXT_WINDOW : undefined;
}

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
/** Every id advertised by OpenRouter's public catalog for the interactive picker. */
let cachedOpenRouterIds: string[] = [];

/** The full id list from the last-fetched OpenRouter catalog (empty before a fetch). */
export function openRouterCatalogIds(): string[] {
  return cachedOpenRouterIds;
}

/**
 * Replace the in-memory OpenRouter id list. An explicit OPENROUTER_MODEL stays
 * the registry default; otherwise the first catalog id becomes the default so
 * `defaultModelFor` points at a real listing.
 */
export function setOpenRouterCatalogIds(ids: string[]): void {
  cachedOpenRouterIds = ids;
  const provider = providerRegistry.find((entry) => entry.id === "openrouter");
  if (!provider) return;
  const preferred = process.env.OPENROUTER_MODEL ?? (ids.length ? ids[0] : undefined);
  const current = provider.models[0]?.model;
  if (preferred && preferred !== current) {
    provider.models = [models("openrouter", `${openRouterBase}/chat/completions`, [preferred], "chat-completions")[0]];
    rebuildAllModels();
  }
}

/** Isolation seam so tests can restore the module-level model cache. */
export function setCachedOpenRouter(table: MetadataMap): void {
  cachedOpenRouter = table;
}

/**
 * Fetch OpenRouter's auth-free public catalog for picker/search use. Failures
 * keep the previously cached ids so a flaky network degrades to the last good
 * list rather than an empty one.
 */
export async function fetchOpenRouterModels(
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const response = await fetcher(openRouterModelsUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) return cachedOpenRouterIds;
    const payload = await response.json();
    const ids = ((payload?.data ?? []) as Array<{ id?: string }>)
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return cachedOpenRouterIds;
    cachedOpenRouterIds = ids;
    // A fresh catalog also refreshes the metadata table that enriches custom ids
    // (Codex catalog generation, /v1/models, provider listing).
    cachedOpenRouter = parseOpenRouterMetadata(payload);
    setOpenRouterCatalogIds(ids);
    return cachedOpenRouterIds;
  } catch {
    return cachedOpenRouterIds;
  }
}

/**
 * Hydrate the in-memory OpenRouter id cache from the last persisted snapshot.
 * A fresh CLI process starts with an empty cache, which made every remembered
 * id look stale to the picker and to `agentx forget` until something in that
 * process happened to trigger a live fetch first; this restores the
 * last-known-good list from disk so offline screening is accurate from the
 * very first call. Routed through `setOpenRouterCatalogIds` so the registry's
 * default model benefits too, same as a live fetch. Never overwrites ids
 * already populated this process (e.g. by an earlier fetch).
 */
export async function hydrateOpenRouterCatalog(): Promise<string[]> {
  if (cachedOpenRouterIds.length) return cachedOpenRouterIds;
  const ids = await loadOpenRouterModels();
  if (ids.length) setOpenRouterCatalogIds(ids);
  return cachedOpenRouterIds;
}

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
  rebuildAllModels();
}

function models(provider: string, endpoint: string, ids: string[], protocol: "responses" | "chat-completions") { return ids.map((model) => ({ provider, model, protocol, endpoint })); }

function openCodeModels(ids: string[], devMetadata?: MetadataMap, routerMetadata?: MetadataMap): ProviderModel[] {
  const ordered = [...ids].sort((a, b) => Number(responsesModelIds.has(b)) - Number(responsesModelIds.has(a)));
  return ordered.map((model) => applyModelMetadata({
    provider: "opencode",
    model,
    protocol: responsesModelIds.has(model) ? "responses" : "chat-completions",
    endpoint: responsesModelIds.has(model) ? `${openCodeBase}/responses` : `${openCodeBase}/chat/completions`,
    ...(deepSeekLongContextWindow(model) !== undefined ? { contextWindow: deepSeekLongContextWindow(model) } : {}),
  }, devMetadata, routerMetadata));
}

/**
 * When this process last knew its in-memory OpenCode model list to be
 * accurate — set by a live fetch or by hydrating a persisted snapshot from
 * disk. Unlike `cachedOpenRouterIds` (which starts empty), the registry's
 * "opencode" entry is always pre-populated with `fallbackOpenCodeIds`
 * synchronously at module load, so an empty-list check can't serve as the
 * "already hydrated this process" guard the way it does for OpenRouter —
 * this timestamp is that guard instead, and doubles as the TTL clock.
 */
let openCodeSnapshotFetchedAt: number | undefined;

function applyOpenCodeIds(ids: string[], fetchedAt: number, devMetadata?: MetadataMap, routerMetadata?: MetadataMap): void {
  const openCode = providerRegistry.find((provider) => provider.id === "opencode");
  if (openCode) {
    openCode.models = openCodeModels(ids, devMetadata, routerMetadata);
    rebuildAllModels();
  }
  openCodeSnapshotFetchedAt = fetchedAt;
}

/**
 * Hydrate the in-memory OpenCode catalog from the last persisted snapshot, so
 * a fresh process doesn't discard a recent live fetch just because it
 * happened in an earlier run. A no-op once this process has already fetched
 * or hydrated (mirrors `hydrateOpenRouterCatalog`'s already-populated guard).
 */
export async function hydrateOpenCodeCatalog(): Promise<string[]> {
  if (openCodeSnapshotFetchedAt !== undefined) return providerRegistry.find((provider) => provider.id === "opencode")?.models.map((model) => model.model) ?? [];
  const snapshot = await loadOpenCodeModels();
  if (snapshot && snapshot.ids.length) applyOpenCodeIds(snapshot.ids, snapshot.fetchedAt);
  return providerRegistry.find((provider) => provider.id === "opencode")?.models.map((model) => model.model) ?? [];
}

/** Test-only: clear the in-memory hydration/TTL guard so a test observes a fresh-process fetch decision. */
export function resetOpenCodeCatalogCache(): void {
  openCodeSnapshotFetchedAt = undefined;
}

export const providerRegistry: ProviderDefinition[] = [
  { id: "opencode", name: "OpenCode", apiKeyEnv: "OPENCODE_API_KEY", models: openCodeModels(fallbackOpenCodeIds) },
  { id: "deepseek", name: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", models: models("deepseek", `${deepSeekBase}/chat/completions`, ["deepseek-v4-pro", "deepseek-v4-flash"], "chat-completions").map((model) => ({ ...model, contextWindow: deepSeekLongContextWindow(model.model) })), quota: { endpoint: "https://api.deepseek.com/user/balance" } },
  { id: "openrouter", name: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", models: models("openrouter", `${openRouterBase}/chat/completions`, [process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini"], "chat-completions"), quota: { endpoint: "https://openrouter.ai/api/v1/key" } }
];

export const allModels = providerRegistry.flatMap((provider) => provider.models);

/** Rebuild `allModels` from the current `providerRegistry` contents in place (same array reference, callers already hold it). */
function rebuildAllModels(): void {
  allModels.splice(0, allModels.length, ...providerRegistry.flatMap((provider) => provider.models));
}

/** Turn an arbitrary display name into a lowercase, hyphenated id segment. */
function slugify(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "custom-provider";
}

/** Derive the ALL_CAPS_WITH_UNDERSCORES env-var suffix AgentX will read the API key from (e.g. "my-llm" -> "MY_LLM_API_KEY", read as AGENTX_MY_LLM_API_KEY). */
function envKeyFor(id: string): string {
  return `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

function customProviderEndpoint(baseUrl: string, protocol: ProviderModel["protocol"]): string {
  const base = baseUrl.replace(/\/+$/, "");
  if (protocol === "anthropic") return `${base}/v1/messages`;
  if (protocol === "responses") return `${base}/responses`;
  return `${base}/chat/completions`;
}

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  protocol: ProviderModel["protocol"];
  /** Upstream doesn't expose a model list for an arbitrary endpoint, so this is a single free-form id (defaults to "custom-model"). */
  model?: string;
}

/**
 * Register (or update) a user-defined provider pointing at an arbitrary
 * OpenAI- or Anthropic-compatible endpoint. Idempotent by derived id:
 * re-registering the same name in place replaces the existing entry instead
 * of duplicating it — this matters because it's called on every launch to
 * re-hydrate providers persisted in runtime.json, not just when a user adds
 * one interactively. Only a clash with a *built-in* provider id gets a
 * numeric suffix; two custom providers whose names happen to slugify to the
 * same id are treated as the same provider slot (last write wins), which is
 * acceptable at the scale a single user configures by hand.
 */
export function registerCustomProvider(input: CustomProviderInput): ProviderDefinition {
  const base = slugify(input.name);
  const existingCustom = providerRegistry.some((entry) => entry.id === base && entry.custom);
  let id = base;
  if (!existingCustom) {
    let suffix = 2;
    while (providerRegistry.some((entry) => entry.id === id)) id = `${base}-${suffix++}`;
  }
  const model: ProviderModel = { provider: id, model: input.model ?? "custom-model", protocol: input.protocol, endpoint: customProviderEndpoint(input.baseUrl, input.protocol) };
  const definition: ProviderDefinition = { id, name: input.name, apiKeyEnv: envKeyFor(id), models: [model], custom: true };
  const index = providerRegistry.findIndex((entry) => entry.id === id);
  if (index >= 0) providerRegistry[index] = definition;
  else providerRegistry.push(definition);
  rebuildAllModels();
  return definition;
}

/** Remove a runtime-registered custom provider from the in-memory registry. Built-in providers cannot be removed this way and this returns false for them. */
export function unregisterCustomProvider(id: string): boolean {
  const index = providerRegistry.findIndex((entry) => entry.id === id && entry.custom);
  if (index < 0) return false;
  providerRegistry.splice(index, 1);
  rebuildAllModels();
  return true;
}

/**
 * Refresh provider model catalogs. OpenCode's list is fetched only when the
 * runtime is unbound or pinned to OpenCode, and only when no persisted
 * snapshot younger than `OPENCODE_CATALOG_TTL_MS` is already in memory — a
 * plain launch that just hydrated a fresh-enough snapshot from disk doesn't
 * need a network round trip on every invocation. Metadata is fetched only
 * when a Codex catalog will be generated; it is applied globally because
 * Codex can enumerate multiple providers through the local proxy. Each
 * source tolerates independent failure and mutations stay in place for
 * existing references. The OpenRouter and OpenCode id caches are always
 * hydrated from disk first (no network), so callers get accurate offline
 * screening even when neither refresh runs — e.g. a plain launch bound to
 * OpenRouter with no `metadata` request.
 */
export async function refreshProviderCatalog(
  options: { provider?: string; metadata?: boolean } = {},
  fetcher: typeof fetch = fetch,
): Promise<{ list: boolean; metadata: boolean }> {
  await hydrateOpenRouterCatalog();
  await hydrateOpenCodeCatalog();
  const wantsList = !options.provider || options.provider === "opencode";
  const listIsFresh = openCodeSnapshotFetchedAt !== undefined && Date.now() - openCodeSnapshotFetchedAt < OPENCODE_CATALOG_TTL_MS;
  const needList = wantsList && !listIsFresh;
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
    // Persist the catalog ids so the launcher / doctor can screen stale
    // remembered models even before a fresh fetch this run.
    if (openRouter.size) {
      cachedOpenRouterIds = [...openRouter.keys()];
      await saveOpenRouterModels(cachedOpenRouterIds);
    }
  }

  let refreshedList = false;
  if (!list) return { list: false, metadata: refreshedMetadata };
  const ids = ((list.data ?? []) as Array<{ id?: string }>).map((item) => item.id).filter((id): id is string => Boolean(id));
  if (ids.length) {
    const openCode = providerRegistry.find((provider) => provider.id === "opencode");
    if (openCode) {
      const fetchedAt = Date.now();
      applyOpenCodeIds(ids, fetchedAt, sections.get("opencode"), openRouter);
      await saveOpenCodeModels({ ids, fetchedAt });
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
