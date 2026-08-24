import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile } from "./fsutil.js";

export interface ProviderProfile {
  id: string;
  provider: string;
  model: string;
  displayName?: string;
  clientModels?: { claude?: string; codex?: string };
}

function profilePath(): string {
  return process.env.AGENTX_PROFILES_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agentx", "profiles.json");
}

export async function loadProfiles(): Promise<ProviderProfile[]> {
  try { return JSON.parse(await readFile(profilePath(), "utf8")) as ProviderProfile[]; } catch { return []; }
}

export async function saveProfile(profile: ProviderProfile): Promise<void> {
  const profiles = (await loadProfiles()).filter((item) => item.id !== profile.id); profiles.push(profile);
  await atomicWriteFile(profilePath(), `${JSON.stringify(profiles, null, 2)}\n`);
}

export function loadLastProfile(): ProviderProfile | undefined {
  try { const profiles = JSON.parse(readFileSync(profilePath(), "utf8")) as ProviderProfile[]; return profiles[profiles.length - 1]; } catch { return undefined; }
}

export function profileFile(): string { return profilePath(); }
