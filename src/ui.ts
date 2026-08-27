import { stdin as input, stdout as output } from "node:process";
import { autocomplete, cancel, intro, isCancel, log, multiselect, note, outro, select, text } from "@clack/prompts";
import { providerRegistry, openRouterCatalogIds } from "./providers/registry.js";
import type { ProviderDefinition } from "./providers/types.js";
import { promptCredential, storedCredential } from "./credentials.js";
import {
  clientDisplayName, defaultModelFor, modelAvailable, providerAcceptsCustomModels, resolveModelForProvider, resolveRuntimeNonInteractive, type RuntimeDecision,
} from "./selection.js";
import {
  forgetRuntime, rememberedModelIds, remembererProviders, saveDefaultRuntime, type RuntimeSelection,
} from "./runtime.js";

/** Thrown when the user cancels the launcher (q / Ctrl+C) instead of launching. */
export class LaunchCancelledError extends Error {
  constructor(readonly exitCode: number, message = "Launch cancelled.") {
    super(message);
    this.name = "LaunchCancelledError";
  }
}

export interface LauncherOutcome extends RuntimeSelection {
  /** True when the user explicitly saved this runtime as the default. */
  madeDefault: boolean;
  /** True when the launcher started from (and kept) a saved default. */
  defaultApplied: boolean;
  /** True when the user interacted to change provider/model this run. */
  changed: boolean;
  /** Session-only API key captured by the launcher for the final provider. */
  apiKey?: string;
}

export interface ProviderEntry {
  definition: ProviderDefinition;
  configured: boolean;
  modelCount: number;
}

/** Providers in registry order with their configured / model-count status. */
export async function providerEntries(): Promise<ProviderEntry[]> {
  const out: ProviderEntry[] = [];
  for (const definition of providerRegistry) {
    out.push({
      definition,
      configured: Boolean(storedCredential(definition)),
      modelCount: definition.models.length,
    });
  }
  return out;
}

/**
 * Interactive runtime launcher.
 *
 * Uses the clack prompt library to present the provider and model pickers in
 * sequence. A saved default short-circuits to a quick-start menu; choosing
 * "Change provider / model" reopens the pickers. Completing the pickers always
 * persists the selection as the client's default, so the next launch starts
 * from it.
 */
export async function runInteractiveLauncher(client: string, initial: RuntimeDecision): Promise<LauncherOutcome> {
  if (!input.isTTY || !output.isTTY) {
    return { provider: initial.provider, model: initial.model, madeDefault: false, defaultApplied: initial.defaultApplied, changed: false };
  }

  const providers = await providerEntries();
  let provider = initial.provider;
  let model = initial.model;
  let madeDefault = false;
  let changed = false;
  let startWithDefault = initial.defaultApplied;
  // Keys entered during this launch, keyed by provider id. Only the key for
  // the finally selected provider is returned; switching to an already
  // configured provider must not leak the earlier key as its credential.
  const sessionKeys = new Map<string, string>();

  // No saved default for this client: help the user pick a first runtime.
  let providerChosenViaFirstUse = false;
  if (!initial.defaultApplied && initial.source === "builtin") {
    const configured = providers.filter((entry) => entry.configured);
    // A single configured provider: deduce it automatically instead of asking.
    if (configured.length === 1) {
      provider = configured[0].definition.id;
      model = await resolveModelForProvider(provider);
      changed = true;
    } else if (configured.length > 1) {
      const chosen = await chooseRuntime(providers, `${clientDisplayName(client)} — AgentX`);
      if (chosen) {
        providerChosenViaFirstUse = true;
        provider = chosen.provider;
        model = await resolveModelForProvider(provider);
        if (chosen.apiKey) sessionKeys.set(provider, chosen.apiKey);
        changed = true;
      }
    }
  }

  // The quick-start path offers the common actions, plus a manager for saved
  // models whose upstream ids were renamed or pulled (e.g. OpenRouter).
  const title = `${clientDisplayName(client)} — AgentX`;
  intro(title);
  if (startWithDefault) {
    log.message(`Using: ${providerLabel(provider)} / ${model}`);
    const shortcut = await selectDefaultAction(provider, model);
    if (isCancel(shortcut) || shortcut === "cancel") { cancel(`${clientDisplayName(client)} launch cancelled`); throw new LaunchCancelledError(0); }
    if (shortcut === "start") {
      outro("Ready");
      return { provider, model, madeDefault: false, defaultApplied: true, changed: false, apiKey: sessionKeys.get(provider) };
    }
    if (shortcut === "manage") {
      await runSavedModelManager();
      // Forgetting may have removed the saved default this client depends on;
      // re-resolve the effective runtime so the picker flow below starts from
      // a valid selection instead of a stale id.
      const fresh = await resolveRuntimeNonInteractive(client, {});
      provider = fresh.provider;
      model = fresh.model;
      changed = true;
    }
  }

  const nextProvider = providerChosenViaFirstUse ? provider : await selectProvider(providers, provider);
  if (isCancel(nextProvider)) { cancel("Provider selection cancelled"); throw new LaunchCancelledError(0); }
  if (nextProvider !== provider) {
    provider = nextProvider;
    model = modelAvailable(provider, model) ? model : await resolveModelForProvider(provider);
    changed = true;
  }

  const entry = providers.find((item) => item.definition.id === provider);
  if (entry && !entry.configured) {
    const apiKey = await configureProvider(entry.definition);
    if (!apiKey) { cancel("Provider not configured"); throw new LaunchCancelledError(0); }
    sessionKeys.set(provider, apiKey);
  }

  const nextModel = await selectModel(provider, model);
  if (isCancel(nextModel)) { cancel("Model selection cancelled"); throw new LaunchCancelledError(0); }
  if (nextModel !== model) { model = nextModel; changed = true; }

  // Reaching the picker flow means the selection is the intended runtime;
  // persist it as the client's default so the next launch starts from it.
  madeDefault = true;
  await saveDefaultRuntime(client, { provider, model });

  outro(changed ? `${providerLabel(provider)} / ${model}` : "Ready");

  return { provider, model, madeDefault, defaultApplied: startWithDefault, changed, apiKey: sessionKeys.get(provider) };
}

function providerLabel(id: string): string {
  const provider = providerRegistry.find((entry) => entry.id === id);
  return provider?.name ?? id;
}

function modelsFor(provider: string): Array<{ model: string }> {
  const definition = providerRegistry.find((entry) => entry.id === provider);
  if (!definition) return [];
  return definition.models.map((item) => ({ model: item.model }));
}

/** Build the provider picker list; configured providers are listed first. */
function providerOptions(entries: ProviderEntry[]): Array<{ value: string; label: string; hint: string }> {
  return [...entries].sort((a, b) => Number(b.configured) - Number(a.configured)).map((entry) => ({
    value: entry.definition.id,
    label: entry.definition.name,
    hint: entry.configured ? `connected · ${entry.modelCount} models` : "not configured",
  }));
}

async function selectProvider(entries: ProviderEntry[], current: string): Promise<string | symbol> {
  return select({ message: "Provider", options: providerOptions(entries), initialValue: current });
}

/** Sentinel option value that switches the model picker into free-form entry. */
const CUSTOM_MODEL_OPTION = "__custom__";
/** Sentinel option value that switches into picker/search over the live catalog. */
const BROWSE_CATALOG_OPTION = "__catalog__";
/** Sentinel option value that routes into the saved-models (forget) manager. */
const FORGET_MODEL_OPTION = "__forget__";

/**
 * Model picker for a provider. Registry models come first; OpenRouter also
 * offers the live public catalog for searchable selection (in addition to
 * free-form entry), so users can find ~400 real ids instead of typing them
 * blind. Choosing "Forget a saved model…" opens the manager scoped to this
 * provider; forgetting may drop a saved custom id, and on return the picker
 * reopens so a fresh selection (or a cancel) is the only way out.
 */
async function selectModel(provider: string, current: string): Promise<string | symbol> {
  const options: Array<{ value: string; label: string; hint?: string }> = modelsFor(provider).map((entry) => ({ value: entry.model, label: entry.model }));
  const custom = providerAcceptsCustomModels(provider);
  // A saved custom id lives outside the registry; surface it as a pickable
  // option so the initial value always matches an entry. When the live
  // catalog is known and no longer lists it, flag that inline so a renamed or
  // pulled id (e.g. a free launch that became its real vendor id) is visible
  // without opening the forget manager.
  if (custom && !options.some((option) => option.value === current)) {
    const catalog = openRouterCatalogIds();
    const stale = catalog.length > 0 && !catalog.includes(current);
    options.unshift({
      value: current,
      label: `${current} · current`,
      ...(stale ? { hint: "renamed or removed upstream?" } : {}),
    });
  }
  if (custom) {
    options.push({ value: CUSTOM_MODEL_OPTION, label: "Search / enter any model id…", hint: "type any model id" });
    options.push({ value: BROWSE_CATALOG_OPTION, label: "Browse OpenRouter catalog…", hint: `~${openRouterCatalogIds().length} models` });
    options.push({ value: FORGET_MODEL_OPTION, label: "Forget a saved model…", hint: "rename / removed ids" });
  }
  // A stale saved default may hold the removed "auto" marker; show a concrete
  // model instead so the initial value always matches an option.
  const initial = options.some((option) => option.value === current) ? current : defaultModelFor(provider);
  const chosen = await autocomplete({
    message: `Model (${providerLabel(provider)})`,
    options,
    initialValue: initial,
    placeholder: "Type to search…",
    maxItems: 12,
    // Keep the free-form entry and catalog-browse entries visible while
    // filtering so users can always reach them, even when their search
    // matches no registered model.
    filter: custom
      ? (search, option) =>
          option.value === CUSTOM_MODEL_OPTION || option.value === BROWSE_CATALOG_OPTION || option.value === FORGET_MODEL_OPTION || defaultModelFilter(search, option)
      : undefined,
    validate: (value) => (value ? undefined : "No matching model — clear the search to see all options."),
  });
  if (chosen === BROWSE_CATALOG_OPTION) {
    return selectFromOpenRouterCatalog(current);
  }
  if (chosen === FORGET_MODEL_OPTION) {
    await runSavedModelManager(provider);
    // The forgotten ids may include the picker's current model; force the
    // next selection from a concrete, still-available option instead of a
    // removed one. Recursion depth is bounded by user cancellations.
    return selectModel(provider, defaultModelFor(provider));
  }
  if (chosen !== CUSTOM_MODEL_OPTION) return chosen;
  return promptCustomModelId(providerLabel(provider), initial);
}

/**
 * Searchable picker over OpenRouter's live public catalog. The current model
 * is offered first so it stays reachable; empty selection cancels back to the
 * model menu.
 */
async function selectFromOpenRouterCatalog(current: string): Promise<string | symbol> {
  const catalog = openRouterCatalogIds();
  const options: Array<{ value: string; label: string; hint?: string }> = catalog.map((model) => ({ value: model, label: model }));
  if (current && !catalog.some((model) => model === current)) {
    options.unshift({ value: current, label: `${current} · current`, hint: "not in the live catalog" });
  }
  if (!options.length) {
    note("OpenRouter's catalog is unavailable right now. Choose another model or enter one manually.", "Catalog");
    return CUSTOM_MODEL_OPTION;
  }
  const chosen = await autocomplete({
    message: "OpenRouter model",
    options,
    placeholder: "Search ~" + catalog.length + " models…",
    maxItems: 12,
    validate: (value) => (value ? undefined : "No matching model — clear the search to see all options."),
  });
  if (isCancel(chosen)) return chosen;
  return chosen;
}

/** Case-insensitive substring match on the option label (clack's default). */
function defaultModelFilter(search: string, option: { label?: string; value: string }): boolean {
  return (option.label ?? String(option.value)).toLowerCase().includes(search.toLowerCase());
}

/**
 * Free-form model id entry for providers that accept arbitrary ids (e.g.
 * OpenRouter). Empty input keeps the suggested id; cancelling propagates so
 * the caller aborts the launch.
 */
async function promptCustomModelId(label: string, suggestion: string): Promise<string | symbol> {
  const entered = await text({
    message: `Custom model id (${label})`,
    placeholder: "vendor/model-name",
    defaultValue: suggestion,
  });
  if (isCancel(entered)) return entered;
  return entered.trim() || suggestion;
}

/**
 * Quick-start menu shown when a saved default exists. The user can launch
 * immediately, enter the full reconfiguration flow, or review/forget saved
 * model ids that are no longer offered upstream.
 */
async function selectDefaultAction(provider: string, model: string): Promise<string | symbol> {
  const runtime = `${providerLabel(provider)} / ${model}`;
  return select({
    message: "",
    options: [
      { value: "start", label: "Start", hint: runtime },
      { value: "change", label: "Change provider / model" },
      { value: "manage", label: "Forget a saved model…", hint: "rename / removed ids" },
      { value: "cancel", label: "Cancel" },
    ],
    initialValue: "start",
  });
}

/**
 * Review & forget saved models. OpenRouter ids are remembered in runtime.json
 * (defaults, per-provider last model, most recent selection); when an upstream
 * model is renamed or pulled (e.g. a free launch renamed to its real vendor
 * id), the stale id keeps being offered as "current" on every launch. This
 * flow lets the user scrub those ids without hand-editing runtime.json.
 *
 * When `provider` is given (reached from that provider's model picker), the
 * provider step is skipped and the list is scoped to that provider.
 */
export async function runSavedModelManager(provider?: string): Promise<void> {
  const providers = await remembererProviders();
  if (provider && !providers.some((entry) => entry.provider === provider)) {
    note(`Nothing is saved for ${providerLabel(provider)} yet. Launch once to record a model.`, "Saved models");
    return;
  }
  if (!provider && !providers.length) {
    note("No saved models were found. Launch once to record a runtime.", "Saved models");
    return;
  }
  const chosenProvider = provider ?? await (async () => {
    const providerOptionsList = providers.map(({ provider }) => ({
      value: provider,
      label: providerLabel(provider),
    }));
    const chosen = await select({
      message: "Provider with saved models",
      options: providerOptionsList,
    });
    if (isCancel(chosen)) return undefined;
    return chosen;
  })();
  if (!chosenProvider) return;
  const ids = await rememberedModelIds(chosenProvider);
  if (!ids.length) {
    note("Nothing is saved for this provider.", "Saved models");
    return;
  }
  const catalog = openRouterCatalogIds();
  const known = (model: string) => catalog.includes(model);
  const modelOptions = ids.map((model) => ({
    value: model,
    label: model,
    hint: known(model) ? "offered upstream" : "no longer listed",
  }));
  const picked = await multiselect({
    message: "Forget saved models (already-removed ids first). Start: repeat to toggle.",
    options: modelOptions,
    required: false,
    initialValues: ids.filter((model) => !known(model)),
    maxItems: 12,
  });
  if (isCancel(picked)) return;
  if (!picked.length) {
    note("Nothing forgotten.", "Saved models");
    return;
  }
  let forgot = 0;
  for (const model of picked) {
    if (await forgetRuntime({ provider: chosenProvider, model })) forgot++;
  }
  if (forgot) note(`Forgot ${forgot} model${forgot === 1 ? "" : "s"} from ${providerLabel(chosenProvider)}.`, "Saved models");
  else note("Nothing forgotten (no saved references were found).", "Saved models");
}

/**
 * First-use "Choose runtime" picker. Configured providers are listed first so
 * users can begin immediately; an unconfigured provider enters the setup flow.
 * Returns the chosen provider with its session key (when prompted for), or
 * undefined when cancelled.
 */
async function chooseRuntime(entries: ProviderEntry[], prompt: string): Promise<{ provider: string; apiKey?: string } | undefined> {
  const entryMap = new Map(entries.map((entry) => [entry.definition.id, entry]));
  const chosen = await select({ message: prompt, options: providerOptions(entries) });
  if (isCancel(chosen)) return undefined;
  const entry = entryMap.get(chosen);
  let apiKey: string | undefined;
  if (entry && !entry.configured) {
    apiKey = await configureProvider(entry.definition);
    if (!apiKey) return undefined;
  }
  return { provider: chosen, apiKey };
}

/**
 * Prompt for a provider's API key. Keys live in the user's environment, so the
 * entered value is valid for this session only; promptCredential explains how
 * to persist it. Returns the key, or undefined when cancelled.
 */
async function configureProvider(definition: ProviderDefinition): Promise<string | undefined> {
  try {
    return await promptCredential(definition);
  } catch {
    return undefined;
  }
}
