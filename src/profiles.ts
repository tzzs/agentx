import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ProviderProfile {
  id: string;
  provider: string;
  model: string;
  displayName?: string;
  clientModels?: { claude?: string; codex?: string };
}

const profilePath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agentx", "profiles.json");

export async function loadProfiles(): Promise<ProviderProfile[]> {
  try { return JSON.parse(await readFile(profilePath, "utf8")) as ProviderProfile[]; } catch { return []; }
}

export async function saveProfile(profile: ProviderProfile): Promise<void> {
  const profiles = (await loadProfiles()).filter((item) => item.id !== profile.id); profiles.push(profile);
  const directory = dirname(profilePath); await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${profilePath}.tmp-${process.pid}`; await writeFile(temporary, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, profilePath);
}

export function loadLastProfile(): ProviderProfile | undefined {
  try { const profiles = JSON.parse(readFileSync(profilePath, "utf8")) as ProviderProfile[]; return profiles[profiles.length - 1]; } catch { return undefined; }
}

export function profileFile(): string { return profilePath; }
