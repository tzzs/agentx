import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { providers } from "./catalog.js";
import { credentialEnvName, providerById } from "./providers/registry.js";
import { storedCredential } from "./credentials.js";

export interface DoctorResult {
  nodeVersion: string;
  platform: string;
  architecture: string;
  providerId: string;
  providerName: string;
  apiKey: string;
  apiKeyFound: boolean;
  models: Array<{ provider: string; model: string }>;
  claudeFound: boolean;
  codexFound: boolean;
  portAvailable: boolean;
  issues: string[];
}

export async function executableExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

export function portAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => { probe.close(() => resolve(true)); });
  });
}

export async function runDoctor(options: Record<string, string | undefined> = {}): Promise<DoctorResult> {
  const config = loadConfig(options);
  const wsl = Boolean(process.env.WSL_INTEROP);
  const provider = providerById(config.provider ?? "opencode");
  const apiKey = config.apiKey || storedCredential(provider) || "";
  const issues: string[] = [];
  if (!apiKey) issues.push(`Set ${credentialEnvName(provider)} (or ${provider.apiKeyEnv}) before starting the adapter, or pass --api-key <key>.`);
  const claudeFound = await executableExists("claude");
  const codexFound = await executableExists("codex");
  if (!claudeFound) issues.push("Claude Code was not found. Install Claude Code and ensure `claude` is on PATH.");
  const available = await portAvailable(config.port, config.host);
  if (!available) issues.push(`Port ${config.port} is in use. The adapter will try the next ports, or use --port to pick another.`);
  return {
    nodeVersion: process.version,
    platform: wsl ? "WSL" : process.platform,
    architecture: process.arch,
    providerId: provider.id,
    providerName: provider.name,
    apiKey,
    apiKeyFound: Boolean(apiKey),
    models: providers.filter((item) => !config.provider || item.provider === config.provider).map((item) => ({ provider: item.provider, model: item.model })),
    claudeFound,
    codexFound,
    portAvailable: available,
    issues,
  };
}

export function renderDoctor(result: DoctorResult): string {
  const ok = (value: boolean) => (value ? "✓" : "✗");
  const lines: string[] = [];
  lines.push("AgentX Doctor", "");
  lines.push("Environment");
  lines.push(`  ${ok(true)} Node.js      ${result.nodeVersion}`);
  lines.push(`  ${ok(true)} Platform     ${result.platform}`);
  lines.push(`  ${ok(true)} Architecture ${result.architecture}`);
  lines.push("");
  lines.push("Provider");
  lines.push(`  ${ok(true)} Provider     ${result.providerName}`);
  lines.push(`  ${ok(result.apiKeyFound)} API key      ${result.apiKeyFound ? "found" : "missing"}`);
  lines.push("");
  lines.push("Models");
  for (const model of result.models) lines.push(`  ${ok(true)} ${model.provider}/${model.model}`);
  lines.push("");
  lines.push("Clients");
  lines.push(`  ${ok(result.claudeFound)} Claude Code  ${result.claudeFound ? "found" : "not found"}`);
  lines.push(`  ${ok(result.codexFound)} Codex         ${result.codexFound ? "found" : "not found"}`);
  lines.push("");
  lines.push("Adapter");
  lines.push(`  ${ok(result.portAvailable)} Port available`);
  lines.push("");
  if (result.issues.length) {
    lines.push("Issues");
    for (const issue of result.issues) lines.push(`  - ${issue}`);
    lines.push("");
    lines.push("Status: Not ready");
  } else {
    lines.push("Status: Ready");
  }
  return lines.join("\n");
}
