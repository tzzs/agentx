import { stdin as input, stdout as output } from "node:process";
import { enterRawMode, exitRawMode } from "./rawMode.js";
import { providerRegistry } from "./providers/registry.js";
import type { ProviderDefinition } from "./providers/types.js";
import { storedCredential, promptAndSaveCredential } from "./credentials.js";
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
      configured: Boolean(await storedCredential(definition)),
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
 * Shows the inline configuration
 *
 *     Claude Code
 *     Provider   OpenCode Go      ›
 *     Model      gpt-5.6-luna     ›
 *                [ Start ]
 *
 * The user can Enter to start, or open the Provider / Model selectors by
 * pressing Enter / Space / Right arrow on the focused row. Temporary switches
 * never overwrite the saved default unless the user picks "Set as default".
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
      const chosen = await chooseRuntime(providers, `${clientDisplayName(client)}\nChoose runtime\n`);
      if (chosen) {
        provider = chosen;
        model = await resolveModelForProvider(chosen);
        changed = true;
      }
    }
  }

  await runUi(client, providers, () => ({ provider, model }), async (next) => {
    provider = next.provider;
    model = next.model;
    changed = true;
  }, async (selection) => {
    provider = selection.provider;
    model = selection.model;
    madeDefault = true;
    changed = true;
    await saveDefaultRuntime(client, selection);
  });

  return { provider, model, madeDefault, defaultApplied: startWithDefault, changed };
}

async function runUi(
  client: string,
  providers: ProviderEntry[],
  get: () => { provider: string; model: string },
  set: (next: RuntimeSelection) => Promise<void>,
  setDefault: (selection: RuntimeSelection) => Promise<void>,
): Promise<void> {
  type Focus = "provider" | "model" | "start";
  let focus: Focus = "start";
  const focusOrder: Focus[] = ["provider", "model", "start"];

  const title = `${clientDisplayName(client)} — AgentX\n`;
  const frame = () => {
    const { provider, model } = get();
    const arrow = (target: Focus) => (focus === target ? "❯" : " ");
    return (
      title +
      `\n` +
      `${arrow("provider")} Provider  ${padRight(padWrap(providerLabel(provider), 20), 20)}›\n` +
      `${arrow("model")} Model     ${padRight(padWrap(model, 28), 28)}›\n` +
      `\n` +
      `${arrow("start")}          [ Start ]\n` +
      `\n` +
      `↑/↓ move · Enter start · Space/→ open selector · s set as default · q quit\n`
    );
  };

  render(frame());

  return new Promise((resolve, reject) => {
    const cleanup = () => { input.off("keypress", onKeypress); exitRawMode(); output.write("\x1b[2J\x1b[H"); };

    // While a nested selector or secret prompt owns the screen, suppress the
    // outer key handling so it cannot move focus, re-render over the picker,
    // or re-open another selector.
    let locked = false;

    const move = (delta: 1 | -1) => {
      const index = focusOrder.indexOf(focus);
      focus = focusOrder[(index + delta + focusOrder.length) % focusOrder.length];
      render(frame());
    };

    const onKeypress = (_: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (locked) return;
      if (key.ctrl && key.name === "c") { cleanup(); reject(new LaunchCancelledError(130)); return; }
      if (key.name === "q") { cleanup(); reject(new LaunchCancelledError(0)); return; }
      if (focus !== "start" && (key.name === "space" || key.name === "right")) {
        // Space / → always opens the focused row's selector, matching the plan.
        if (focus === "provider") void openProviderSelector();
        else void openModelSelector();
        return;
      }
      if (key.name === "up" || key.name === "down" || key.name === "tab") { move(key.name === "up" ? -1 : 1); return; }
      if (key.name === "s") { void setDefault(get()); render(frame()); return; }
      if (key.name === "return" || key.name === "enter") {
        if (focus === "provider") { void openProviderSelector(); return; }
        if (focus === "model") { void openModelSelector(); return; }
        // Default focus ("start") or explicit [ Start ] invokes launch.
        cleanup(); resolve(); return;
      }
    };

    async function openProviderSelector() {
      locked = true;
      try {
        const current = get().provider;
        const selector = providerSelectorEntries(providers, current);
        const selected = await chooseFromList(selector.entries, `${title}\nChange Provider\n`, selector.currentIndex);
        if (selected === undefined) return;
        const nextProvider = selected.value;
        const entry = providers.find((item) => item.definition.id === nextProvider);
        // Provider has no credential yet: enter the configuration flow.
        if (entry && !entry.configured) {
          const configured = await configureProvider(entry.definition);
          if (!configured) return;
        }
        const currentModel = get().model;
        // Restore the provider's last model unless the current model still works.
        const nextModel = modelAvailable(nextProvider, currentModel) ? currentModel : await resolveModelForProvider(nextProvider);
        await set({ provider: nextProvider, model: nextModel });
      } finally {
        locked = false;
        render(frame());
      }
    }

    async function openModelSelector() {
      locked = true;
      try {
        const provider = get().provider;
        const models = modelsFor(provider);
        const entries = [{ value: "auto", label: "● Auto — Automatically choose a suitable model" }, ...models.map((entry) => ({ value: entry.model, label: entry.model }))];
        const selected = await chooseFromList(entries, `${title}\nChange Model\n`);
        if (selected === undefined) return;
        await set({ provider, model: selected.value });
      } finally {
        locked = false;
        render(frame());
      }
    }

    enterRawMode();
    input.on("keypress", onKeypress);
  });
}

function render(text: string) {
  output.write("\x1b[2J\x1b[H");
  output.write(text);
}

function padWrap(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

function padRight(value: string, width: number): string {
  return value.padEnd(width);
}

function providerLabel(id: string): string {
  const provider = providerRegistry.find((entry) => entry.id === id);
  return provider?.name ?? id;
}

function providerItemLabel(entry: ProviderEntry, current?: string): string {
  const selected = entry.definition.id === current ? "✓ " : "  ";
  const base = entry.definition.name;
  if (!entry.configured) return `${selected}${base} — not configured`;
  return `${selected}${base} — connected · ${entry.modelCount} models`;
}

function modelsFor(provider: string): Array<{ model: string }> {
  const definition = providerRegistry.find((entry) => entry.id === provider);
  if (!definition) return [];
  return definition.models.map((item) => ({ model: item.model }));
}

/** Build the Change Provider list, marking and preselecting the current one. */
function providerSelectorEntries(entries: ProviderEntry[], current: string): { entries: Array<{ value: string; label: string }>; currentIndex: number } {
  const ordered = [...entries].sort((a, b) => Number(b.configured) - Number(a.configured));
  const list = ordered.map((entry) => ({ value: entry.definition.id, label: providerItemLabel(entry, current) }));
  const index = Math.max(0, ordered.findIndex((entry) => entry.definition.id === current));
  return { entries: list, currentIndex: index };
}

/**
 * First-use "Choose runtime" picker. Configured providers are listed first so
 * users can begin immediately; an unconfigured provider enters the setup flow.
 * Returns the chosen provider id, or undefined when cancelled.
 */
async function chooseRuntime(entries: ProviderEntry[], prompt: string): Promise<string | undefined> {
  const ordered = [...entries].sort((a, b) => Number(b.configured) - Number(a.configured));
  const entryMap = new Map(ordered.map((entry) => [entry.definition.id, entry]));
  const list = ordered.map((entry) => ({ value: entry.definition.id, label: providerItemLabel(entry) }));
  const chosen = await chooseFromList(list, prompt);
  if (chosen === undefined) return undefined;
  const entry = entryMap.get(chosen.value);
  if (entry && !entry.configured) {
    const done = await configureProvider(entry.definition);
    if (!done) return undefined;
  }
  return chosen.value;
}

/**
 * Prompt for a provider's API key and persist it in the secure credential
 * store. Returns true once the provider is configured.
 */
async function configureProvider(definition: ProviderDefinition): Promise<boolean> {
  render(`${definition.name}\n\nNot configured\n\nAPI key required\n\nPaste the API key and press Enter (Esc to cancel):\n`);
  try {
    await promptAndSaveCredential(definition);
  } catch {
    return false;
  }
  render(`${definition.name}\n\n✓ Connected\n`);
  return true;
}

/**
 * Generic keyboard list picker. Returns the selected entry, or undefined when
 * the user cancels. First entry is pre-selected.
 */
async function chooseFromList<T extends { label: string }>(entries: Array<T & { value: string }>, prompt: string, preselect = 0): Promise<(T & { value: string }) | undefined> {
  if (!input.isTTY || !output.isTTY) return entries[preselect];
  let selected = entries.length ? preselect % entries.length : 0;
  const paint = () => {
    let text = prompt + "\n";
    entries.forEach((entry, index) => { text += `${index === selected ? "❯" : " "} ${entry.label}\n`; });
    text += "\n↑/↓ select · Enter confirm · Esc cancel\n";
    render(text);
  };
  paint();
  return new Promise((resolve) => {
    const cleanup = () => { input.off("keypress", onKey); exitRawMode(); };
    const onKey = (_: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") { cleanup(); resolve(undefined); return; }
      if (key.name === "escape") { cleanup(); resolve(undefined); return; }
      if (key.name === "up") { selected = (selected + entries.length - 1) % entries.length; paint(); return; }
      if (key.name === "down") { selected = (selected + 1) % entries.length; paint(); return; }
      if (key.name === "return" || key.name === "enter") { const chosen = entries[selected]; cleanup(); resolve(chosen); return; }
    };
    enterRawMode();
    input.on("keypress", onKey);
  });
}


