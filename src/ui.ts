import { stdin as input, stdout as output } from "node:process";
import { cancel, intro, isCancel, outro, select } from "@clack/prompts";
import { providerRegistry } from "./providers/registry.js";
import type { ProviderDefinition } from "./providers/types.js";
import { promptCredential, storedCredential } from "./credentials.js";
import {
  clientDisplayName, defaultModelFor, modelAvailable, resolveModelForProvider, type RuntimeDecision,
} from "./selection.js";
import {
  saveDefaultRuntime, type RuntimeSelection,
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

/** Default usable model for a provider, honouring "auto" preferences. */
export function defaultModel(provider: string): string {
  return defaultModelFor(provider);
}

/**
 * Interactive runtime launcher.
 *
 * Uses the clack prompt library to present the provider and model pickers in
 * sequence. The user can start with the current runtime, or save it as the
 * default for the client. Temporary switches never overwrite the saved default
 * unless the user picks "Set as default".
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

  // No saved default for this client: help the user pick a first runtime.
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
        provider = chosen;
        model = await resolveModelForProvider(chosen);
        changed = true;
      }
    }
  }

  const title = `${clientDisplayName(client)} — AgentX`;
  intro(title);

  const nextProvider = await selectProvider(providers, provider);
  if (isCancel(nextProvider)) { cancel("Provider selection cancelled"); throw new LaunchCancelledError(0); }
  if (nextProvider !== provider) {
    provider = nextProvider;
    model = modelAvailable(provider, model) ? model : await resolveModelForProvider(provider);
    changed = true;
  }

  const entry = providers.find((item) => item.definition.id === provider);
  if (entry && !entry.configured) {
    const configured = await configureProvider(entry.definition);
    if (!configured) { cancel("Provider not configured"); throw new LaunchCancelledError(0); }
  }

  const nextModel = await selectModel(provider, model);
  if (isCancel(nextModel)) { cancel("Model selection cancelled"); throw new LaunchCancelledError(0); }
  if (nextModel !== model) { model = nextModel; changed = true; }

  const action = await selectAction(client, provider, model);
  if (isCancel(action) || action === "cancel") { cancel(`${clientDisplayName(client)} launch cancelled`); throw new LaunchCancelledError(0); }
  if (action === "default") {
    madeDefault = true;
    changed = true;
    await saveDefaultRuntime(client, { provider, model });
  }

  outro(changed ? `${providerLabel(provider)} / ${model}` : "Ready");

  return { provider, model, madeDefault, defaultApplied: startWithDefault, changed };
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

/** Build the Change Provider list, marking and preselecting the current one. */
function providerOptions(entries: ProviderEntry[], current: string): { options: Array<{ value: string; label: string; hint: string }>; initialValue: string } {
  const ordered = [...entries].sort((a, b) => Number(b.configured) - Number(a.configured));
  const options = ordered.map((entry) => {
    const base = entry.definition.name;
    return {
      value: entry.definition.id,
      label: base,
      hint: entry.configured ? `connected · ${entry.modelCount} models` : "not configured",
    };
  });
  return { options, initialValue: current };
}

async function selectProvider(entries: ProviderEntry[], current: string): Promise<string | symbol> {
  const { options, initialValue } = providerOptions(entries, current);
  return select({ message: "Provider", options, initialValue });
}

async function selectModel(provider: string, current: string): Promise<string | symbol> {
  const options = [
    { value: "auto", label: "Auto", hint: "Automatically choose a suitable model" },
    ...modelsFor(provider).map((entry) => ({ value: entry.model, label: entry.model })),
  ];
  return select({ message: `Model (${providerLabel(provider)})`, options, initialValue: current });
}

async function selectAction(client: string, provider: string, model: string): Promise<string | symbol> {
  const runtime = `${providerLabel(provider)} / ${model}`;
  return select({
    message: "Start?",
    options: [
      { value: "start", label: "Start now", hint: runtime },
      { value: "default", label: "Set as default and start", hint: `remember ${runtime}` },
      { value: "cancel", label: "Cancel" },
    ],
    initialValue: "start",
  });
}

/**
 * First-use "Choose runtime" picker. Configured providers are listed first so
 * users can begin immediately; an unconfigured provider enters the setup flow.
 * Returns the chosen provider id, or undefined when cancelled.
 */
async function chooseRuntime(entries: ProviderEntry[], prompt: string): Promise<string | undefined> {
  const ordered = [...entries].sort((a, b) => Number(b.configured) - Number(a.configured));
  const entryMap = new Map(ordered.map((entry) => [entry.definition.id, entry]));
  const options = ordered.map((entry) => ({
    value: entry.definition.id,
    label: entry.definition.name,
    hint: entry.configured ? `connected · ${entry.modelCount} models` : "not configured",
  }));
  const chosen = await select({ message: prompt, options });
  if (isCancel(chosen)) return undefined;
  const entry = entryMap.get(chosen);
  if (entry && !entry.configured) {
    const done = await configureProvider(entry.definition);
    if (!done) return undefined;
  }
  return chosen;
}

/**
 * Prompt for a provider's API key. Keys live in the user's environment, so the
 * entered value is valid for this session only; promptCredential explains how
 * to persist it. Returns true once a key was obtained.
 */
async function configureProvider(definition: ProviderDefinition): Promise<boolean> {
  try {
    await promptCredential(definition);
    return true;
  } catch {
    return false;
  }
}