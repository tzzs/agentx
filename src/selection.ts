import { loadDefaultRuntime, loadLastModel } from "./runtime.js";

import { allModels, providerById } from "./providers/registry.js";

export type RuntimeSource = "cli" | "env" | "default" | "interactive" | "builtin";

export interface RuntimeDecision {
  provider: string;
  model: string;
  /**
   * Where the winning provider/model came from. Used to decide whether the
   * interactive launcher should appear and whether a default was consulted.
   */
  source: RuntimeSource;
  /** True when the decision came from a saved default runtime. */
  defaultApplied: boolean;
}

export function clientDisplayName(client: string): string {
  if (client === "codex") return "Codex";
  if (client === "pi") return "Pi";
  if (client === "proxy") return "Proxy";
  if (client === "exec") return "Exec";
  return "Claude Code";
}

/** The default model the project assumes for a provider when none is recorded. */
export function defaultModelFor(providerId: string): string {
  const provider = providerById(providerId);
  return provider.models[0]?.model ?? "";
}

/** True when the provider accepts arbitrary model ids beyond its registry list. */
export function providerAcceptsCustomModels(providerId: string): boolean {
  // OpenRouter proxies every upstream model and is not enumerated exhaustively.
  if (providerId === "openrouter") return true;
  // A runtime-registered custom provider has no known model catalog either.
  try { return Boolean(providerById(providerId).custom); } catch { return false; }
}

/** True when the model id is usable against the provider (or is the auto marker). */
export function modelAvailable(providerId: string, model: string): boolean {
  if (providerAcceptsCustomModels(providerId)) return true;
  return allModels.some((item) => item.provider === providerId && item.model === model);
}

/**
 * Resolve the model to use with a provider. Preferences, in order:
 *   1. an explicitly preferred model that belongs to the provider
 *   2. the provider's remembered last model
 *   3. the provider's default model
 */
export async function resolveModelForProvider(providerId: string, preferred?: string): Promise<string> {
  if (preferred !== undefined && modelAvailable(providerId, preferred)) return preferred;
  const last = await loadLastModel(providerId);
  if (last && modelAvailable(providerId, last)) return last;
  return defaultModelFor(providerId);
}

/**
 * Decide the runtime to use for a client from persistent state and CLI/env
 * defaults only (no interaction). This is the automation path used when the
 * terminal is not interactive or when explicit flags are supplied.
 */
export async function resolveRuntimeNonInteractive(client: string, opts: Record<string, string | undefined>): Promise<RuntimeDecision> {
  const cliProvider = opts.provider;
  const cliModel = opts.model;
  if (cliProvider || cliModel) {
    const provider = cliProvider ?? (cliModel ? providerForModel(cliModel) : undefined) ?? "opencode";
    const model = cliModel ?? (cliProvider ? await resolveModelForProvider(cliProvider) : defaultModelFor(provider));
    return { provider, model, source: "cli", defaultApplied: false };
  }

  const envProvider = process.env.AGENTX_PROVIDER;
  const envModel = process.env.AGENTX_MODEL;
  if (envProvider || envModel) {
    const provider = envProvider ?? (envModel ? providerForModel(envModel) : undefined) ?? "opencode";
    const model = envModel ?? (envProvider ? await resolveModelForProvider(envProvider) : defaultModelFor(provider));
    return { provider, model, source: "env", defaultApplied: false };
  }

  const saved = await loadDefaultRuntime(client);
  if (saved && providerIdExists(saved.provider)) {
    const model = await resolveModelForProvider(saved.provider, saved.model);
    return { provider: saved.provider, model, source: "default", defaultApplied: true };
  }

  const provider = "opencode";
  return { provider, model: defaultModelFor(provider), source: "builtin", defaultApplied: false };
}

function providerIdExists(id: string): boolean {
  try { providerById(id); return true; } catch { return false; }
}

function providerForModel(model: string): string {
  const hit = allModels.find((item) => item.model === model);
  return hit?.provider ?? "opencode";
}
