import type { ProviderCapabilities } from "./types.js";
import { providerById } from "../providers/registry.js";

const defaults: ProviderCapabilities = { supportsUsage: true, supportsStreamingUsage: true, supportsCacheTokens: false };

const fallback: Record<string, Partial<ProviderCapabilities>> = {
  opencode: { supportsCacheTokens: true },
  deepseek: { supportsCacheTokens: true },
  openrouter: { supportsCacheTokens: false },
  anthropic: { supportsCacheTokens: true },
  google: { supportsCacheTokens: true }
};

export function capabilitiesFor(provider: string): ProviderCapabilities {
  try {
    const definition = providerById(provider);
    if (definition.capabilities) return { ...defaults, ...definition.capabilities };
  } catch { /* Provider not registered; use fallback metadata. */ }
  return { ...defaults, ...(fallback[provider] ?? {}) };
}