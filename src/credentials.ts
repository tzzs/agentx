import { createRequire } from "node:module";
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

export async function deleteCredential(provider: ProviderDefinition): Promise<boolean> {
  const backend = keytar(); if (!backend) return false; await backend.deletePassword(SERVICE, provider.id); return true;
}
export function credentialStoreAvailable(): boolean { return Boolean(keytar()); }
async function promptSecret(label: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error("Secret input requires an interactive terminal.");
  output.write(label); input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => { input.setRawMode(false); input.pause(); input.off("data", onData); output.write("\n"); };
    const onData = (chunk: Buffer) => { for (const byte of chunk) { if (byte === 3) { cleanup(); reject(new Error("Credential input cancelled.")); return; } if (byte === 13 || byte === 10) { cleanup(); resolve(value); return; } if (byte === 127 || byte === 8) value = value.slice(0, -1); else if (byte >= 32) value += String.fromCharCode(byte); } };
    input.on("data", onData);
  });
}
export async function promptAndSaveCredential(provider: ProviderDefinition): Promise<string> {
  const value = (await promptSecret(`${provider.name} API key: `)).trim(); if (!value) throw new Error("API key cannot be empty.");
  if (!(await saveCredential(provider, value))) console.error("Warning: secure credential storage is unavailable; using this key for the current session only.");
  return value;
}

export async function resolveCredential(provider: ProviderDefinition, override?: string): Promise<string> {
  if (override) return override;
  const existing = await storedCredential(provider); if (existing) return existing;
  if (!input.isTTY || !output.isTTY) throw new Error(`API key not found for ${provider.name}. Set ${provider.apiKeyEnv} in non-interactive mode.`);
  return promptAndSaveCredential(provider);
}
