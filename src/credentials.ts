import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ProviderDefinition } from "./providers/types.js";

const require = createRequire(import.meta.url);
const SERVICE = "agentx";

function keytar(): any | undefined { try { return require("keytar"); } catch { return undefined; } }

export async function storedCredential(provider: ProviderDefinition): Promise<string | undefined> {
  return (await keytar()?.getPassword(SERVICE, provider.id)) || process.env[provider.apiKeyEnv];
}

export async function saveCredential(provider: ProviderDefinition, value: string): Promise<boolean> {
  const backend = keytar(); if (!backend) return false; await backend.setPassword(SERVICE, provider.id, value); return true;
}

export async function resolveCredential(provider: ProviderDefinition, override?: string): Promise<string> {
  if (override) return override;
  const existing = await storedCredential(provider); if (existing) return existing;
  if (!input.isTTY || !output.isTTY) throw new Error(`API key not found for ${provider.name}. Set ${provider.apiKeyEnv} in non-interactive mode.`);
  const line = createInterface({ input, output });
  try {
    const value = (await line.question(`${provider.name} API key: `)).trim();
    if (!value) throw new Error("API key cannot be empty.");
    if (!(await saveCredential(provider, value))) console.error("Warning: secure credential storage is unavailable; using this key for the current session only.");
    return value;
  } finally { line.close(); }
}
