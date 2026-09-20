import { stdin as realStdin, stdout as realStdout } from "node:process";
import { autocomplete, cancel, confirm, intro, isCancel, multiselect, note, outro, select, text } from "@clack/prompts";
import { providerRegistry, credentialEnvName, isPlaceholderModel, openRouterCatalogIds, providerById, registerCustomProvider, unregisterCustomProvider } from "./providers/registry.js";
import type { ProviderDefinition, ProviderProtocol } from "./providers/types.js";
import { credentialInstructions, credentialSource, hydrateProfileCredentials, promptCredential, promptCredentialValue, storedCredential } from "./credentials.js";
import { shellProfilePath, writeCredentialExport } from "./shell-profile.js";
import {
  clientDisplayName, defaultModelFor, providerAcceptsCustomModels, resolveModelForProvider, resolveRuntimeNonInteractive, type RuntimeDecision,
} from "./selection.js";
import {
  forgetCustomProvider, forgetRuntime, loadLastQuickAction, rememberedModelIds, remembererProviders, saveCustomProvider, saveDefaultRuntime,
  saveLastQuickAction, type RuntimeSelection,
} from "./runtime.js";

/** Injectable I/O streams every prompt in this module renders through; real process stdio by default. */
let io: { input: NodeJS.ReadStream; output: NodeJS.WriteStream } = { input: realStdin, output: realStdout };
/** `{ input, output }` spread into every clack call so it honors the current `io`. */
function stdio() { return { input: io.input, output: io.output }; }

/**
 * Test-only seam: point every prompt this module renders at fake streams
 * instead of real process stdio, so the interactive flows (Add/Remove custom
 * provider, provider/model pickers, …) are actually drivable in tests.
 */
export function __setTestIO(next: { input: NodeJS.ReadStream; output: NodeJS.WriteStream }): void { io = next; }
/** Restore real process stdio after a test that called `__setTestIO`. */
export function __resetTestIO(): void { io = { input: realStdin, output: realStdout }; }

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
  /** True when the user chose to launch the client natively, bypassing the AgentX adapter entirely. */
  native?: boolean;
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
 * sequence. Unless an explicit `--provider`/`--model`/env override picked the
 * runtime already, a top-level menu asks the transport question first — native
 * vs AgentX-routed — with its option set shaped by what's already known about
 * this client (see `selectTopLevelAction`). Choosing "Configure a provider" /
 * "Select provider / model" / "Change provider / model" (the same destination,
 * worded for whichever state the user is in) reopens the pickers below.
 * Completing the pickers always persists the selection as the client's
 * default, so the next launch starts from it.
 */
export async function runInteractiveLauncher(client: string, initial: RuntimeDecision): Promise<LauncherOutcome> {
  if (!io.input.isTTY || !io.output.isTTY) {
    return { provider: initial.provider, model: initial.model, madeDefault: false, defaultApplied: initial.defaultApplied, changed: false };
  }

  let providers = await providerEntries();
  let provider = initial.provider;
  let model = initial.model;
  let madeDefault = false;
  let changed = false;
  const defaultApplied = initial.defaultApplied;
  // Keys entered during this launch, keyed by provider id. Only the key for
  // the finally selected provider is returned; switching to an already
  // configured provider must not leak the earlier key as its credential.
  const sessionKeys = new Map<string, string>();

  const title = `${clientDisplayName(client)} — AgentX`;
  intro(title, stdio());

  // An explicit --provider/--model/env override already picked the runtime;
  // skip the transport question and go straight to confirming it below.
  if (initial.source === "builtin" || initial.source === "default") {
    // No saved default for this client yet: default the picker to a provider
    // that's already configured (if any) instead of the hardcoded fallback.
    if (!defaultApplied) {
      const configured = providers.find((entry) => entry.configured);
      if (configured) {
        provider = configured.definition.id;
        // The initial model belonged to the fallback provider; without this
        // the model picker would offer that foreign id as "current".
        model = await resolveModelForProvider(provider);
      }
    }

    const action = await selectTopLevelAction(client, providers, provider, model, defaultApplied);
    if (isCancel(action) || action === "cancel") { cancel(`${clientDisplayName(client)} launch cancelled`, stdio()); throw new LaunchCancelledError(0); }
    if (action === "start") {
      await saveLastQuickAction(client, "start");
      outro("Ready", stdio());
      return { provider, model, madeDefault: false, defaultApplied, changed: false, apiKey: sessionKeys.get(provider) };
    }
    if (action === "native") {
      await saveLastQuickAction(client, "native");
      outro("Launching native — adapter skipped", stdio());
      return { provider, model, madeDefault: false, defaultApplied, changed: false, native: true };
    }
    if (action === "manage") {
      await runSavedModelManager();
      // Forgetting may have removed the saved default this client depends on;
      // re-resolve the effective runtime so the picker flow below starts from
      // a valid selection instead of a stale id.
      const fresh = await resolveRuntimeNonInteractive(client, {});
      provider = fresh.provider;
      model = fresh.model;
      changed = true;
    }
    // action === "change": fall through into the provider/model pickers below.
  }

  const nextProvider = await selectProvider(providers, provider);
  if (isCancel(nextProvider)) { cancel("Provider selection cancelled", stdio()); throw new LaunchCancelledError(0); }
  if (nextProvider !== provider) {
    provider = nextProvider;
    // selectProvider may have added or removed a custom provider along the way.
    providers = await providerEntries();
    // Resolve from the new provider's own memory: model ids are provider-
    // scoped, so carrying the previous provider's pick over would show a
    // foreign model as "current" (custom endpoints accept any id, which used
    // to make the carry-over stick for exactly the wrong providers).
    model = await resolveModelForProvider(provider);
    changed = true;
  }

  const entry = providers.find((item) => item.definition.id === provider);
  if (entry && !entry.configured) {
    const apiKey = await configureProvider(entry.definition);
    if (!apiKey) { cancel("Provider not configured", stdio()); throw new LaunchCancelledError(0); }
    sessionKeys.set(provider, apiKey);
  }

  const nextModel = await selectModel(provider, model);
  if (isCancel(nextModel)) { cancel("Model selection cancelled", stdio()); throw new LaunchCancelledError(0); }
  if (nextModel !== model) { model = nextModel; changed = true; }

  // Reaching the picker flow means the selection is the intended runtime;
  // persist it as the client's default so the next launch starts from it.
  madeDefault = true;
  await saveDefaultRuntime(client, { provider, model });

  outro(changed ? `${providerLabel(provider)} / ${model}` : "Ready", stdio());

  return { provider, model, madeDefault, defaultApplied, changed, apiKey: sessionKeys.get(provider) };
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

/** Sentinel option value that opens the "add a custom provider" prompt sequence. */
const ADD_CUSTOM_PROVIDER_OPTION = "__add_custom_provider__";
/** Sentinel option value that opens the "remove a custom provider" prompt, shown only once one exists. */
const REMOVE_CUSTOM_PROVIDER_OPTION = "__remove_custom_provider__";

/**
 * The three upstream wire shapes, listed one per line: protocol name, then the
 * path AgentX appends to the base URL. Only the Chat Completions line carries
 * a trailing note — it is OpenAI's earlier API, which is the one non-obvious
 * positioning; "native" and "recommended" would just repeat the names. The
 * name columns are padded because clack renders labels verbatim, so that is
 * what keeps the paths aligned.
 */
function protocolOption(name: string, path: string, tag?: string): string {
  return `${name.padEnd(24)}· ${path}${tag ? ` · ${tag}` : ""}`;
}
const PROTOCOL_OPTIONS: Array<{ value: ProviderProtocol; label: string }> = [
  { value: "anthropic", label: protocolOption("Anthropic Messages", "/v1/messages") },
  { value: "responses", label: protocolOption("OpenAI Responses", "/responses") },
  { value: "chat-completions", label: protocolOption("OpenAI Chat Completions", "/chat/completions", "legacy") },
];

/** What the user types is a base URL; AgentX appends this path (see `customProviderEndpoint` in providers/registry.ts). */
const BASE_URL_PROMPTS: Record<ProviderProtocol, { placeholder: string; appendedPath: string }> = {
  "chat-completions": { placeholder: "https://api.openai.com/v1", appendedPath: "/chat/completions" },
  responses: { placeholder: "https://api.openai.com/v1", appendedPath: "/responses" },
  anthropic: { placeholder: "https://api.anthropic.com", appendedPath: "/v1/messages" },
};

/**
 * Prompt sequence for a new custom OpenAI/Anthropic-compatible provider:
 * protocol, base URL, then display name. The URL prompt states the path AgentX
 * appends so nobody pastes a full endpoint path into a base URL. Registers and
 * persists the connection metadata only — never the API key, matching every
 * other provider; the name comes last so the caller's existing "not
 * configured yet" handling (in `runInteractiveLauncher`, right after provider
 * selection) can immediately prompt for the key with the name at hand.
 * Returns the new provider's id, or undefined if cancelled at any step.
 */
async function addCustomProviderFlow(): Promise<string | undefined> {
  const protocol = await select({ message: "Protocol", options: PROTOCOL_OPTIONS, ...stdio() });
  if (isCancel(protocol)) return undefined;
  const { placeholder, appendedPath } = BASE_URL_PROMPTS[protocol];
  const baseUrl = await text({
    message: `Base URL (AgentX appends ${appendedPath})`,
    placeholder,
    validate: (value) => { try { new URL(value ?? ""); return undefined; } catch { return `Enter a full URL, e.g. ${placeholder}`; } },
    ...stdio(),
  });
  if (isCancel(baseUrl)) return undefined;
  const name = await text({ message: "Provider name", placeholder: "My Local LLM", ...stdio() });
  if (isCancel(name) || !name.trim()) return undefined;
  const definition = registerCustomProvider({ name: name.trim(), baseUrl, protocol });
  await saveCustomProvider(definition.id, { name: definition.name, baseUrl, protocol, model: definition.models[0].model });
  note(`✓ ${definition.name} added`, "Custom provider", stdio());
  return definition.id;
}

/** Pick a custom provider to remove entirely (definition + persisted memory). Built-in providers never appear in this list. */
async function removeCustomProviderFlow(entries: ProviderEntry[]): Promise<void> {
  const custom = entries.filter((entry) => entry.definition.custom);
  const chosen = await select({ message: "Remove custom provider", options: custom.map((entry) => ({ value: entry.definition.id, label: entry.definition.name })), ...stdio() });
  if (isCancel(chosen)) return;
  const label = custom.find((entry) => entry.definition.id === chosen)?.definition.name ?? chosen;
  unregisterCustomProvider(chosen);
  await forgetCustomProvider(chosen);
  note(`Removed ${label}.`, "Custom provider", stdio());
}

/** Sentinel option value that closes the standalone provider manager. */
const DONE_CONFIG_OPTION = "__done__";

/** Credential status for a provider: where the key comes from, or how to set it. */
function credentialStatusText(provider: ProviderDefinition): string {
  const source = credentialSource(provider);
  return source ? `Credential: configured via ${source}.` : credentialInstructions(provider);
}

/**
 * Config-only key setup. Persists the key as a managed `export` block in the
 * user's shell profile — the one place AgentX ever writes a secret, and only
 * after the user confirms both the write and the value. Without a supported
 * profile (fish, SHELL unset) it falls back to manual instructions.
 */
async function offerCredentialSetup(provider: ProviderDefinition): Promise<void> {
  const envName = credentialEnvName(provider);
  const profile = shellProfilePath();
  if (!profile) {
    note(credentialInstructions(provider), provider.name, stdio());
    return;
  }
  const accepted = await confirm({ message: `Write ${envName} to ${profile}?`, initialValue: true, ...stdio() });
  if (isCancel(accepted) || !accepted) {
    note(credentialInstructions(provider), provider.name, stdio());
    return;
  }
  let key: string;
  try {
    key = await promptCredentialValue(provider, io);
  } catch {
    note(credentialInstructions(provider), provider.name, stdio());
    return;
  }
  try {
    const result = await writeCredentialExport(profile, envName, key);
    const lines = result.changed
      ? [
          `Wrote ${envName} to ${result.file}.`,
          ...(result.backup ? [`Backup: ${result.backup}`] : []),
          `Activate it in a new terminal, or run: source ${result.file}`,
          `Undo: remove the "# >>> agentx credentials" block, or restore the backup.`,
        ]
      : [`${envName} is already up to date in ${result.file}.`];
    if (result.mode !== undefined && (result.mode & 0o077) !== 0) {
      lines.push(`Warning: ${result.file} is readable by other local users (mode ${result.mode.toString(8)}); consider: chmod 600 ${result.file}`);
    }
    // Re-read the profile instead of mutating process.env: keys must never
    // enter the environment that gets inherited by a launched client.
    await hydrateProfileCredentials();
    note(lines.join("\n"), provider.name, stdio());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    note(`${message}\n\n${credentialInstructions(provider)}`, provider.name, stdio());
  }
}

/**
 * Standalone provider manager behind `agentx config`: list providers with
 * their credential status, add or remove custom providers, and set up API
 * keys — all without starting the adapter or a client. AgentX keeps no key
 * store of its own: an opted-in key setup is written to the user's shell
 * profile (see `offerCredentialSetup`). Runs until the user picks Done or
 * cancels.
 */
export async function runProviderManager(): Promise<void> {
  intro("AgentX — Provider configuration", stdio());
  for (;;) {
    const entries = await providerEntries();
    const options: Array<{ value: string; label: string; hint?: string }> = entries.map((entry) => ({
      value: entry.definition.id,
      label: entry.definition.name,
      hint: entry.configured ? `connected · ${credentialSource(entry.definition)}` : "API key missing",
    }));
    options.push({ value: ADD_CUSTOM_PROVIDER_OPTION, label: "Add custom provider…", hint: "OpenAI or Anthropic-compatible endpoint" });
    if (entries.some((entry) => entry.definition.custom)) {
      options.push({ value: REMOVE_CUSTOM_PROVIDER_OPTION, label: "Remove custom provider…", hint: "" });
    }
    options.push({ value: DONE_CONFIG_OPTION, label: "Done" });

    const chosen = await select({ message: "Providers", options, ...stdio() });
    if (isCancel(chosen) || chosen === DONE_CONFIG_OPTION) break;
    if (chosen === ADD_CUSTOM_PROVIDER_OPTION) {
      const added = await addCustomProviderFlow();
      const definition = added ? providerById(added) : undefined;
      if (definition && !storedCredential(definition)) await offerCredentialSetup(definition);
      continue;
    }
    if (chosen === REMOVE_CUSTOM_PROVIDER_OPTION) {
      await removeCustomProviderFlow(entries);
      continue;
    }
    const definition = entries.find((entry) => entry.definition.id === chosen)?.definition;
    if (!definition) continue;
    if (storedCredential(definition)) note(credentialStatusText(definition), definition.name, stdio());
    else await offerCredentialSetup(definition);
  }
  outro("Provider configuration saved. API keys stay in your environment.", stdio());
}

/** Exported for tests: drives the Provider picker, including the Add/Remove custom provider sentinels. */
export async function selectProvider(entries: ProviderEntry[], current: string): Promise<string | symbol> {
  const choices = providerOptions(entries);
  choices.push({ value: ADD_CUSTOM_PROVIDER_OPTION, label: "Add custom provider…", hint: "OpenAI or Anthropic-compatible endpoint" });
  if (entries.some((entry) => entry.definition.custom)) {
    choices.push({ value: REMOVE_CUSTOM_PROVIDER_OPTION, label: "Remove custom provider…", hint: "" });
  }
  const chosen = await select({ message: "Provider", options: choices, initialValue: current, ...stdio() });
  if (isCancel(chosen)) return chosen;
  if (chosen === ADD_CUSTOM_PROVIDER_OPTION) {
    const added = await addCustomProviderFlow();
    // On success return the new id straight away: the caller's credential
    // prompt follows immediately, so the user goes URL → name → key without
    // an extra stop back on the picker. Only a cancellation reopens it.
    if (added) return added;
    return selectProvider(await providerEntries(), current);
  }
  if (chosen === REMOVE_CUSTOM_PROVIDER_OPTION) {
    await removeCustomProviderFlow(entries);
    return selectProvider(await providerEntries(), current);
  }
  return chosen;
}

/** Sentinel option value that switches the model picker into free-form entry. */
const CUSTOM_MODEL_OPTION = "__custom__";
/** Sentinel option value that switches into picker/search over the live catalog. */
const BROWSE_CATALOG_OPTION = "__catalog__";
/** Sentinel option value that routes into the saved-models (forget) manager. */
const FORGET_MODEL_OPTION = "__forget__";

/**
 * Model picker for a provider. Registry models come first. Providers that
 * accept arbitrary ids (OpenRouter, runtime-registered custom endpoints) also
 * offer free-form entry; the live-catalog browse is OpenRouter-specific and
 * only that provider shows it. "Forget a saved model…" appears only when this
 * provider actually has saved ids, and opens the manager scoped to it;
 * forgetting may drop the picker's current model, and on return the picker
 * reopens so a fresh selection (or a cancel) is the only way out.
 */
async function selectModel(provider: string, current: string): Promise<string | symbol> {
  // A runtime-registered custom endpoint's synthesized placeholder model is
  // not a real upstream id, so it is never offered as a choice or shown as
  // "current" (see `isPlaceholderModel`).
  const options: Array<{ value: string; label: string; hint?: string }> = modelsFor(provider)
    .filter((entry) => !isPlaceholderModel({ model: entry.model, provider }))
    .map((entry) => ({ value: entry.model, label: entry.model }));
  const custom = providerAcceptsCustomModels(provider);
  // A saved custom id lives outside the registry; surface it as a pickable
  // option so the initial value always matches an entry. When the live
  // catalog is known and no longer lists it, flag that inline so a renamed or
  // pulled id (e.g. a free launch that became its real vendor id) is visible
  // without opening the forget manager.
  if (custom && !isPlaceholderModel({ model: current, provider }) && !options.some((option) => option.value === current)) {
    // Staleness is only judgeable against OpenRouter's public catalog; custom
    // endpoints have no comparable listing, so their ids are offered as-is.
    const stale = provider === "openrouter" && openRouterCatalogIds().length > 0 && !openRouterCatalogIds().includes(current);
    options.unshift({
      value: current,
      label: `${current} · current`,
      ...(stale ? { hint: "renamed or removed upstream?" } : {}),
    });
  }
  if (custom) {
    options.push({ value: CUSTOM_MODEL_OPTION, label: "Search / enter any model id…", hint: "type any model id" });
  }
  if (provider === "openrouter") {
    options.push({ value: BROWSE_CATALOG_OPTION, label: "Browse OpenRouter catalog…", hint: `~${openRouterCatalogIds().length} models` });
  }
  if (custom && (await rememberedModelIds(provider)).some((id) => !isPlaceholderModel({ model: id, provider }))) {
    options.push({ value: FORGET_MODEL_OPTION, label: "Forget a saved model…", hint: "rename / removed ids" });
  }
  // A fresh custom endpoint has no real registry model and no saved id: asking
  // for the model id directly beats a picker whose only entry is free-form.
  if (custom && options.length === 1 && options[0].value === CUSTOM_MODEL_OPTION) {
    return promptCustomModelId(providerLabel(provider), "");
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
    ...stdio(),
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
    note("OpenRouter's catalog is unavailable right now. Choose another model or enter one manually.", "Catalog", stdio());
    return CUSTOM_MODEL_OPTION;
  }
  const chosen = await autocomplete({
    message: "OpenRouter model",
    options,
    placeholder: "Search ~" + catalog.length + " models…",
    maxItems: 12,
    validate: (value) => (value ? undefined : "No matching model — clear the search to see all options."),
    ...stdio(),
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
 * OpenRouter, custom endpoints). An empty input keeps the suggested id when
 * there is one; with no suggestion the entry is required. Cancelling
 * propagates so the caller aborts the launch.
 */
async function promptCustomModelId(label: string, suggestion: string): Promise<string | symbol> {
  const entered = await text({
    message: `Custom model id (${label})`,
    placeholder: "vendor/model-name",
    ...(suggestion ? { defaultValue: suggestion } : {}),
    validate: (value) => (value?.trim() || suggestion ? undefined : "Enter a model id, e.g. deepseek-chat"),
    ...stdio(),
  });
  if (isCancel(entered)) return entered;
  return entered.trim() || suggestion;
}

/**
 * Top-level menu shown before anything else (unless an explicit
 * --provider/--model/env override already picked the runtime — see the
 * `initial.source` check in `runInteractiveLauncher`). Its option set is
 * shaped by two independent signals: whether any provider has been
 * configured at all, and whether this specific client has a saved default
 * runtime (`defaultApplied`, i.e. has completed the picker below before):
 *
 *   - nothing configured yet:      Configure a provider / [Native] / Cancel
 *   - configured, never used here: Select provider / model / [Native] / Cancel
 *   - configured and used before:  Start / [Native] / Change provider / model / [Forget] / Cancel
 *
 * Native only appears for clients with their own login/billing outside
 * AgentX (see NATIVE_CAPABLE_CLIENTS); "Forget a saved model…" only appears
 * once there's actually something saved to forget.
 */
const NATIVE_CAPABLE_CLIENTS = new Set(["claude", "codex"]);

async function selectTopLevelAction(
  client: string,
  providers: ProviderEntry[],
  provider: string,
  model: string,
  defaultApplied: boolean,
): Promise<string | symbol> {
  const nativeCapable = NATIVE_CAPABLE_CLIENTS.has(client);
  const hasConfiguredProvider = providers.some((entry) => entry.configured);
  const hasSavedModels = (await remembererProviders()).length > 0;

  const nativeOption = { value: "native", label: "Launch native (skip AgentX)", hint: "no adapter, no env overrides" };
  const changeOption = defaultApplied
    ? { value: "change", label: "Change provider / model" }
    : {
        value: "change",
        label: hasConfiguredProvider ? "Select provider / model" : "Configure a provider",
        hint: hasConfiguredProvider ? undefined : "connect an upstream (API key required)",
      };

  // A saved default puts the fast path ("Start") first; otherwise the
  // provider/model step is the primary action and leads, with native (an
  // escape hatch around AgentX entirely) right after it.
  const options: Array<{ value: string; label: string; hint?: string }> = defaultApplied
    ? [{ value: "start", label: "Start", hint: `${providerLabel(provider)} / ${model}` }, ...(nativeCapable ? [nativeOption] : []), changeOption]
    : [changeOption, ...(nativeCapable ? [nativeOption] : [])];
  if (hasSavedModels) options.push({ value: "manage", label: "Forget a saved model…", hint: "rename / removed ids" });
  options.push({ value: "cancel", label: "Cancel" });

  // Recalling the last quick-start pick only makes sense once there's a
  // "Start" to fall back to; cases without a saved default always default
  // the cursor to the primary (first) option instead.
  const lastAction = defaultApplied ? await loadLastQuickAction(client) : undefined;
  const initialValue = lastAction === "native" && nativeCapable ? "native" : options[0].value;

  return select({ message: "", options, initialValue, ...stdio() });
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
    note(`Nothing is saved for ${providerLabel(provider)} yet. Launch once to record a model.`, "Saved models", stdio());
    return;
  }
  if (!provider && !providers.length) {
    note("No saved models were found. Launch once to record a runtime.", "Saved models", stdio());
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
      ...stdio(),
    });
    if (isCancel(chosen)) return undefined;
    return chosen;
  })();
  if (!chosenProvider) return;
  const ids = await rememberedModelIds(chosenProvider);
  if (!ids.length) {
    note("Nothing is saved for this provider.", "Saved models", stdio());
    return;
  }
  // Staleness is only judgeable for OpenRouter, whose public catalog is the
  // one machine-checkable upstream listing (and is vendor-prefixed, so bare
  // ids from other providers must never be compared against it).
  const catalog = openRouterCatalogIds();
  const known = (model: string) => chosenProvider !== "openrouter" || catalog.includes(model);
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
    ...stdio(),
  });
  if (isCancel(picked)) return;
  if (!picked.length) {
    note("Nothing forgotten.", "Saved models", stdio());
    return;
  }
  let forgot = 0;
  for (const model of picked) {
    if (await forgetRuntime({ provider: chosenProvider, model })) forgot++;
  }
  if (forgot) note(`Forgot ${forgot} model${forgot === 1 ? "" : "s"} from ${providerLabel(chosenProvider)}.`, "Saved models", stdio());
  else note("Nothing forgotten (no saved references were found).", "Saved models", stdio());
}

/**
 * Prompt for a provider's API key. Keys live in the user's environment, so the
 * entered value is valid for this session only; promptCredential explains how
 * to persist it. Returns the key, or undefined when cancelled.
 */
async function configureProvider(definition: ProviderDefinition): Promise<string | undefined> {
  try {
    return await promptCredential(definition, io);
  } catch {
    return undefined;
  }
}
