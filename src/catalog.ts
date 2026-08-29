import { allModels, providerFor as resolveProvider } from "./providers/registry.js";
import type { ProviderModel } from "./providers/types.js";

export type ModelProvider = ProviderModel;
export const providers = allModels;
export function providerFor(model: string, provider?: string): ModelProvider { return resolveProvider(model, provider); }

/**
 * Honor a client-requested model whenever the configured provider serves it;
 * unknown ids and "auto" fall back to the configured model. This is what makes
 * tiered clients work (e.g. Claude Code's haiku background lane reaching a
 * faster sibling via --background-model); by design it lets any loopback
 * client pick any model of the same provider — the local token is random and
 * never leaves the machine, so this widens model choice, not access.
 */
export function honorRequestedModel(requested: unknown, fallback: string, providerId?: string): string {
  if (typeof requested !== "string" || !requested || requested === fallback) return fallback;
  try { const match = resolveProvider(requested, providerId); return match.model === requested ? requested : fallback; } catch { return fallback; }
}
