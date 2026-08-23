import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { confirm, isCancel, password } from "@clack/prompts";
import type { ProviderDefinition } from "./providers/types.js";
import { credentialEnvName } from "./providers/registry.js";

export function storedCredential(provider: ProviderDefinition): string | undefined {
  return process.env[credentialEnvName(provider)] || process.env[provider.apiKeyEnv] || undefined;
}

/** Which environment variable provided the credential, for `auth status`. */
export function credentialSource(provider: ProviderDefinition): string | undefined {
  if (process.env[credentialEnvName(provider)]) return credentialEnvName(provider);
  if (process.env[provider.apiKeyEnv]) return provider.apiKeyEnv;
  return undefined;
}

/** Shell-profile setup instructions shown by `agentx auth login`. */
export function credentialInstructions(provider: ProviderDefinition): string {
  return [
    `${provider.name} credentials are read from the environment.`,
    "",
    "Add this line to your shell profile (~/.zshrc or ~/.bashrc), then reload it:",
    `  export ${credentialEnvName(provider)}="<your-${provider.id}-api-key>"`,
    "",
    `An already-set ${provider.apiKeyEnv} is also picked up directly.`,
    "Run `source ~/.zshrc` afterwards and verify with `agentx auth status`.",
  ].join("\n");
}

/**
 * Shell profile to persist credentials into, chosen from $SHELL with a
 * fallback to whichever known profile already exists.
 */
export function shellProfilePath(): string {
  const home = homedir();
  const shell = process.env.SHELL ?? "";
  const candidates: string[] = [];
  if (shell.endsWith("fish")) {
    candidates.push(join(home, ".config", "fish", "config.fish"));
  } else if (shell.endsWith("zsh")) {
    candidates.push(join(home, ".zshrc"));
  } else if (shell.endsWith("bash")) {
    candidates.push(join(home, ".bashrc"), join(home, ".bash_profile"));
  } else {
    candidates.push(join(home, ".bashrc"), join(home, ".zshrc"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function exportLine(provider: ProviderDefinition, key: string): string {
  const escaped = key.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
  return `export ${credentialEnvName(provider)}="${escaped}"`;
}

/** Append `export AGENTX_*_API_KEY=...` to the shell profile if not already set. */
export async function persistCredentialToProfile(provider: ProviderDefinition, key: string): Promise<string> {
  const profile = shellProfilePath();
  const variable = credentialEnvName(provider);
  let content = "";
  try { content = await readFile(profile, "utf8"); } catch { /* new file */ }
  if (new RegExp(`^\\s*export\\s+${variable}\\s*=`, "m").test(content)) return profile;
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  const line = exportLine(provider, key);
  await mkdir(dirname(profile), { recursive: true, mode: 0o700 });
  await writeFile(profile, `${content}${separator}${line}\n`, { mode: 0o600 });
  return profile;
}

/**
 * Prompt for a provider API key. After the value is entered the user is
 * asked (default yes) whether to persist it as `AGENTX_<PROVIDER>_API_KEY`
 * in the shell profile; otherwise the value is valid for the current session
 * only and the user is told how to persist it manually.
 */
export async function promptCredential(provider: ProviderDefinition): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error("Secret input requires an interactive terminal.");
  const value = await password({
    message: `${provider.name} API key`,
    validate: (entry) => (entry?.trim().length ? undefined : "API key cannot be empty."),
  });
  if (isCancel(value)) throw new Error("Credential input cancelled.");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("API key cannot be empty.");
  const persist = await confirm({
    message: `Save ${credentialEnvName(provider)} to your shell profile for future sessions?`,
    initialValue: true,
  });
  if (isCancel(persist)) throw new Error("Credential input cancelled.");
  if (persist) {
    const profile = await persistCredentialToProfile(provider, trimmed);
    console.error(`✓ Saved ${credentialEnvName(provider)} to ${profile}\n  It will be picked up by new terminal sessions.`);
  } else {
    console.error(`Session-only key. Persist it by adding to your shell profile (e.g. ~/.zshrc):\n  export ${credentialEnvName(provider)}="<your-key>"`);
  }
  return trimmed;
}

export async function resolveCredential(provider: ProviderDefinition, override?: string): Promise<string> {
  if (override) return override;
  const existing = storedCredential(provider);
  if (existing) return existing;
  if (!input.isTTY || !output.isTTY) throw new Error(`API key not found for ${provider.name}. Set ${credentialEnvName(provider)} (or ${provider.apiKeyEnv}) in non-interactive mode.`);
  return promptCredential(provider);
}
