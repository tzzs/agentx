import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile } from "./fsutil.js";

/**
 * A runtime is the combination of a provider and the model it will use for a
 * given invocation of an agent client (Claude Code, Codex, Pi, ...).
 *
 * Provider and model are deliberately bound together: switching provider must
 * resolve the model against the target provider rather than reusing one that
 * belongs to a different provider.
 */
export interface RuntimeSelection {
  provider: string;
  model: string;
}

/** Persistent, non-secret agent runtime state (no API keys ever stored here). */
export interface RuntimeState {
  /** Default runtime per client id (claude, codex, pi). */
  defaults: Record<string, RuntimeSelection>;
  /** Last model used per provider id, so switching back restores it. */
  lastModels: Record<string, string>;
}

/** Config directory path; reads env lazily so tests can redirect it. */
export function configDir(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

function stateFile(): string {
  return join(configDir(), "agentx", "runtime.json");
}

export async function loadRuntimeState(): Promise<RuntimeState> {
  try {
    const raw = JSON.parse(await readFile(stateFile(), "utf8")) as Partial<RuntimeState>;
    return {
      defaults: raw.defaults ?? {},
      lastModels: raw.lastModels ?? {},
    };
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

/** Last model recorded for a provider, if any. */
export async function loadLastModel(provider: string): Promise<string | undefined> {
  return (await loadRuntimeState()).lastModels[provider];
}

/** Remember the model used with a provider ("last model per provider"). */
export async function saveLastModel(provider: string, model: string): Promise<void> {
  const state = await loadRuntimeState();
  state.lastModels[provider] = model;
  await writeRuntimeState(state);
}

/** Path used for diagnostics and tests. */
export function runtimeFile(): string {
  return stateFile();
}
