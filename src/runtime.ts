import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile } from "./fsutil.js";

/**
 * A runtime is the combination of a provider and the model it will use for a
 * given invocation of an agent client (Claude Code, Codex, ...).
 *
 * Provider and model are deliberately bound together: switching provider must
 * resolve the model against the target provider rather than reusing one that
 * belongs to a different provider.
 */
export interface RuntimeSelection {
  provider: string;
  model: string;
}

/** Connection metadata for a user-registered custom provider. Never includes an API key. */
export interface CustomProviderState {
  name: string;
  baseUrl: string;
  protocol: string;
  model?: string;
}

/**
 * Launch parameters recorded for one client (Claude Code/Codex) session id, so
 * a later `--resume`/`resume` of the same id can restore how it was launched
 * without asking again. `mode` is written explicitly at record time rather
 * than inferred from which fields are present — an untracked session id must
 * read as "unknown", never silently as "native".
 */
export interface SessionRecord {
  client: string;
  mode: "native" | "agentx";
  /** Only meaningful when mode is "agentx" — native sessions never went through AgentX's routing. */
  provider?: string;
  model?: string;
  recordedAt: number;
}

/** Persistent, non-secret agent runtime state (no API keys ever stored here). */
export interface RuntimeState {
  /** Default runtime per client id (claude, codex). */
  defaults: Record<string, RuntimeSelection>;
  /** Last model used per provider id, so switching back restores it. */
  lastModels: Record<string, string>;
  /** Most recent concrete selection, including its provider. */
  last?: RuntimeSelection;
  /** Last-seen OpenRouter catalog ids (cached models.dev-style data, not user state). */
  openrouterModels?: string[];
  /** Last-seen OpenCode catalog ids plus the time they were fetched, so a fresh snapshot can skip a live refetch. */
  opencodeModels?: { ids: string[]; fetchedAt: number };
  /** User-registered custom providers, keyed by their derived id. Connection metadata only — never an API key. */
  customProviders?: Record<string, CustomProviderState>;
  /** Last quick-start action picked per client ("start" or "native"), so the next launch's quick-start menu defaults to it. */
  lastQuickAction?: Record<string, string>;
  /** Launch parameters keyed by the client's own session id, so `--resume` can restore them. See {@link SessionRecord}. */
  sessions?: Record<string, SessionRecord>;
}

/** Config directory path; reads env lazily so tests can redirect it. */
export function configDir(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

function stateFile(): string {
  return join(configDir(), "agentx", "runtime.json");
}

function normalizeState(raw: Partial<RuntimeState>): RuntimeState {
  const defaults = raw.defaults ?? {};
  const lastModels = raw.lastModels ?? {};
  // Older versions kept only ordered profiles.json entries. runtime.json has
  // always been the richer state file, so absent `last` simply means that the
  // next launch uses the provider default instead of guessing a provider.
  const last = raw.last && raw.last.provider && raw.last.model
    ? { provider: raw.last.provider, model: raw.last.model }
    : undefined;
  // The OpenRouter catalog id cache is metadata, not user state, but it must
  // round-trip or every offline launch loses the screening list.
  const openrouterModels = Array.isArray(raw.openrouterModels) ? raw.openrouterModels : [];
  const opencodeModels = raw.opencodeModels && Array.isArray(raw.opencodeModels.ids) && typeof raw.opencodeModels.fetchedAt === "number"
    ? { ids: raw.opencodeModels.ids, fetchedAt: raw.opencodeModels.fetchedAt }
    : undefined;
  const customProviders = raw.customProviders && typeof raw.customProviders === "object" ? raw.customProviders : {};
  const lastQuickAction = raw.lastQuickAction && typeof raw.lastQuickAction === "object" ? raw.lastQuickAction : {};
  const sessions = raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {};
  return { defaults, lastModels, openrouterModels, customProviders, lastQuickAction, sessions, ...(last ? { last } : {}), ...(opencodeModels ? { opencodeModels } : {}) };
}

export async function loadRuntimeState(): Promise<RuntimeState> {
  try {
    const raw = JSON.parse(await readFile(stateFile(), "utf8")) as Partial<RuntimeState>;
    return normalizeState(raw);
  } catch {
    return { defaults: {}, lastModels: {} };
  }
}

async function writeRuntimeState(state: RuntimeState): Promise<void> {
  await atomicWriteFile(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
}

/** Default runtime for a client, if one has been saved. */
export async function loadDefaultRuntime(client: string): Promise<RuntimeSelection | undefined> {
  return (await loadRuntimeState()).defaults[client];
}

/** Persist the default runtime for a client ("Set as default"). */
export async function saveDefaultRuntime(client: string, selection: RuntimeSelection): Promise<void> {
  const state = await loadRuntimeState();
  state.defaults[client] = { provider: selection.provider, model: selection.model };
  await writeRuntimeState(state);
}

/** Last quick-start action ("start" or "native") picked for a client, if any. */
export async function loadLastQuickAction(client: string): Promise<string | undefined> {
  return (await loadRuntimeState()).lastQuickAction?.[client];
}

/** Persist the quick-start action picked for a client, so the next launch's menu defaults to it. */
export async function saveLastQuickAction(client: string, action: string): Promise<void> {
  const state = await loadRuntimeState();
  state.lastQuickAction = { ...state.lastQuickAction, [client]: action };
  await writeRuntimeState(state);
}

/** Last model recorded for a provider, if any. */
export async function loadLastModel(provider: string): Promise<string | undefined> {
  return (await loadRuntimeState()).lastModels[provider];
}

/** The most recent provider/model selection, regardless of client. */
export async function loadLastSelection(): Promise<RuntimeSelection | undefined> {
  return (await loadRuntimeState()).last;
}

/** Forgetting intent to carry across the CLI boundary. */
export interface ForgetSelection {
  /** Context used for messaging and state indexing. */
  provider: string;
  /** Optional model id filter; when present, only that model is forgotten. */
  model?: string;
}

/**
 * Remove every trace of a model id from the runtime state. Dirty OpenRouter ids
 * (e.g. a free launch that got renamed or pulled) are remembered only here, so
 * forgetting them here is the single cleanup path: it also drops a client
 * default or the most recent selection that pointed at the id. When no model
 * is given, the whole provider's memory is cleared.
 */
export async function forgetRuntime(on: ForgetSelection, model?: string): Promise<boolean> {
  const state = await loadRuntimeState();
  const target = model ?? on.model;
  let damaged = false;
  for (const [client, selection] of Object.entries(state.defaults)) {
    if (selection.provider !== on.provider) continue;
    if (target !== undefined && selection.model !== target) continue;
    delete state.defaults[client];
    damaged = true;
  }
  if (on.provider in state.lastModels && (target === undefined || state.lastModels[on.provider] === target)) {
    delete state.lastModels[on.provider];
    damaged = true;
  }
  if (
    state.last && state.last.provider === on.provider &&
    (target === undefined || state.last.model === target)
  ) {
    // Clearing the most recent selection must not invent a new one.
    delete state.last;
    damaged = true;
  }
  if (!damaged) return false;
  await writeRuntimeState(state);
  return true;
}

/** Persist (or update) a custom provider's connection metadata. Never pass an API key here. */
export async function saveCustomProvider(id: string, definition: CustomProviderState): Promise<void> {
  const state = await loadRuntimeState();
  state.customProviders = { ...state.customProviders, [id]: definition };
  await writeRuntimeState(state);
}

/** All persisted custom providers, keyed by id. */
export async function loadCustomProviders(): Promise<Record<string, CustomProviderState>> {
  return (await loadRuntimeState()).customProviders ?? {};
}

/**
 * Remove a custom provider's persisted definition, plus any default/last-model/
 * last-selection memory that pointed at it (via `forgetRuntime`) — so a
 * removed provider doesn't linger as a saved default that no longer resolves.
 * Pair with `unregisterCustomProvider` (providers/registry.ts) to also drop
 * it from the in-memory registry for the current process.
 */
export async function forgetCustomProvider(id: string): Promise<boolean> {
  const state = await loadRuntimeState();
  const existed = Boolean(state.customProviders?.[id]);
  if (existed) {
    const { [id]: _removed, ...rest } = state.customProviders ?? {};
    state.customProviders = rest;
    await writeRuntimeState(state);
  }
  const clearedMemory = await forgetRuntime({ provider: id });
  return existed || clearedMemory;
}

/** Provider ids with remembered state (defaults, last models, last selection). */
export async function remembererProviders(): Promise<Array<{ provider: string }>> {
  const state = await loadRuntimeState();
  const out: Array<{ provider: string }> = [];
  const seen = new Set<string>();
  for (const selection of Object.values(state.defaults)) if (selection?.provider && !seen.has(selection.provider)) { seen.add(selection.provider); out.push({ provider: selection.provider }); }
  for (const provider of Object.keys(state.lastModels)) if (!seen.has(provider)) { seen.add(provider); out.push({ provider }); }
  if (state.last?.provider && !seen.has(state.last.provider)) out.push({ provider: state.last.provider });
  return out;
}

/** Ids remembered for a provider, drawn from any state section that holds them. */
export async function rememberedModelIds(provider: string): Promise<string[]> {
  const state = await loadRuntimeState();
  const seen = new Set<string>();
  for (const selection of Object.values(state.defaults)) if (selection?.provider === provider && selection.model) seen.add(selection.model);
  if (state.lastModels[provider]) seen.add(state.lastModels[provider]);
  if (state.last?.provider === provider && state.last.model) seen.add(state.last.model);
  return [...seen];
}

/**
 * Remember the model used with a provider. Updating the provider map also
 * records the most recent selection so `proxy`/`exec` can restore it without
 * a separate profile file.
 */
export async function saveLastModel(provider: string, model: string): Promise<void> {
  const state = await loadRuntimeState();
  state.lastModels[provider] = model;
  state.last = { provider, model };
  await writeRuntimeState(state);
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Persist the last-seen OpenRouter catalog ids into the runtime state.
 * Skips the write when the list is unchanged — `agentx forget` and other
 * screening paths call this on every run even when the catalog hasn't moved,
 * and rewriting runtime.json for identical content is wasted disk I/O.
 */
export async function saveOpenRouterModels(ids: string[]): Promise<void> {
  const state = await loadRuntimeState();
  if (sameIds(state.openrouterModels ?? [], ids)) return;
  state.openrouterModels = ids;
  await writeRuntimeState(state);
}

/** Last-seen OpenRouter catalog ids, or an empty list before the first fetch. */
export async function loadOpenRouterModels(): Promise<string[]> {
  return (await loadRuntimeState()).openrouterModels ?? [];
}

/**
 * Persist the last-seen OpenCode catalog ids with the time they were fetched,
 * so a later process can decide whether the snapshot is still fresh enough to
 * skip a live refetch (see `hydrateOpenCodeCatalog` in providers/registry.ts).
 */
export async function saveOpenCodeModels(snapshot: { ids: string[]; fetchedAt: number }): Promise<void> {
  const state = await loadRuntimeState();
  state.opencodeModels = snapshot;
  await writeRuntimeState(state);
}

/** Last-seen OpenCode catalog ids and fetch time, if any snapshot has ever been persisted. */
export async function loadOpenCodeModels(): Promise<{ ids: string[]; fetchedAt: number } | undefined> {
  return (await loadRuntimeState()).opencodeModels;
}

/** Cap on remembered sessions so runtime.json doesn't grow without bound over long-term use. */
const MAX_REMEMBERED_SESSIONS = 200;

/** Persist (or refresh) the launch parameters used for one client session id. */
export async function saveSessionRecord(sessionId: string, record: SessionRecord): Promise<void> {
  const state = await loadRuntimeState();
  const sessions: Record<string, SessionRecord> = { ...state.sessions, [sessionId]: record };
  const ids = Object.keys(sessions);
  if (ids.length > MAX_REMEMBERED_SESSIONS) {
    const oldest = ids.sort((a, b) => sessions[a].recordedAt - sessions[b].recordedAt).slice(0, ids.length - MAX_REMEMBERED_SESSIONS);
    for (const id of oldest) delete sessions[id];
  }
  state.sessions = sessions;
  await writeRuntimeState(state);
}

/** The recorded launch parameters for a client session id, if AgentX has seen it before. */
export async function loadSessionRecord(sessionId: string): Promise<SessionRecord | undefined> {
  return (await loadRuntimeState()).sessions?.[sessionId];
}

/** Path used for diagnostics and tests. */
export function runtimeFile(): string {
  return stateFile();
}
