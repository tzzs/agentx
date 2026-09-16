import { stdin as input, stdout as output } from "node:process";
import { isCancel, password } from "@clack/prompts";
import type { ProviderDefinition } from "./providers/types.js";
import { credentialEnvName } from "./providers/registry.js";
import { readCredentialExports, shellProfilePath } from "./shell-profile.js";

/**
 * Credentials loaded from the marker blocks `agentx config` writes into the
 * user's shell profile. Kept in this side map instead of being copied into
 * `process.env` on purpose: `clientEnvironment` hands an inherited
 * environment to the launched client, so a key merged into the process env
 * would ride into Claude/Codex. Environment variables always win over these.
 */
const profileCredentials = new Map<string, { value: string; file: string }>();

/** Load (or clear, when no supported profile applies) the shell-profile credential blocks. Called once per CLI invocation. */
export async function hydrateProfileCredentials(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<void> {
  profileCredentials.clear();
  const file = shellProfilePath(env, platform);
  if (!file) return;
  for (const [name, value] of await readCredentialExports(file)) profileCredentials.set(name, { value, file });
}

/** Test seam: drop the profile-backed credentials without touching the real file. */
export function resetProfileCredentials(): void {
  profileCredentials.clear();
}

export function storedCredential(provider: ProviderDefinition): string | undefined {
  return process.env[credentialEnvName(provider)] || process.env[provider.apiKeyEnv] || profileCredentials.get(credentialEnvName(provider))?.value || undefined;
}

/** Which source provided the credential, for `auth status` and picker hints — the profile path is included when it came from there. */
export function credentialSource(provider: ProviderDefinition): string | undefined {
  if (process.env[credentialEnvName(provider)]) return credentialEnvName(provider);
  if (process.env[provider.apiKeyEnv]) return provider.apiKeyEnv;
  const fromProfile = profileCredentials.get(credentialEnvName(provider));
  return fromProfile ? `${credentialEnvName(provider)} (from ${fromProfile.file})` : undefined;
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
 * Masked key input with no side effects, for callers that persist the value
 * themselves (e.g. `agentx config` writing it to the shell profile). `io`
 * defaults to real process stdio; ui.ts passes its injectable test streams.
 */
export async function promptCredentialValue(provider: ProviderDefinition, io: { input: NodeJS.ReadStream; output: NodeJS.WriteStream } = { input, output }): Promise<string> {
  if (!io.input.isTTY || !io.output.isTTY) throw new Error("Secret input requires an interactive terminal.");
  const value = await password({
    message: `${provider.name} API key`,
    validate: (entry) => (entry?.trim().length ? undefined : "API key cannot be empty."),
    input: io.input,
    output: io.output,
  });
  if (isCancel(value)) throw new Error("Credential input cancelled.");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("API key cannot be empty.");
  return trimmed;
}

/**
 * Prompt for a provider API key. The value is valid for the current session
 * only; instructions are printed so the user can persist it manually. `io`
 * defaults to real process stdio; the interactive launcher (ui.ts) passes its
 * own injectable streams through so this participates in the same test seam.
 */
export async function promptCredential(provider: ProviderDefinition, io: { input: NodeJS.ReadStream; output: NodeJS.WriteStream } = { input, output }): Promise<string> {
  const trimmed = await promptCredentialValue(provider, io);
  console.error(`Session-only key. Persist it by adding to your shell profile (e.g. ~/.zshrc):\n  export ${credentialEnvName(provider)}="<your-key>"`);
  return trimmed;
}

export async function resolveCredential(provider: ProviderDefinition, override?: string): Promise<string> {
  if (override) return override;
  const existing = storedCredential(provider);
  if (existing) return existing;
  if (!input.isTTY || !output.isTTY) throw new Error(`API key not found for ${provider.name}. Set ${credentialEnvName(provider)} (or ${provider.apiKeyEnv}) in non-interactive mode.`);
  return promptCredential(provider);
}
