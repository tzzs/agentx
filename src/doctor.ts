import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { providers } from "./catalog.js";
import { credentialEnvName, providerById } from "./providers/registry.js";
import { storedCredential } from "./credentials.js";

/** Which client set the doctor should inspect. `"all"` keeps historical behavior. */
export type DoctorClient = "claude" | "codex" | "all";

export interface DoctorOptions {
  client?: DoctorClient;
  offline?: boolean;
  /** Other flags (provider, port, host, api-key, …) flow through to loadConfig. */
  [key: string]: string | undefined | boolean | DoctorClient;
}

export interface DoctorResult {
  nodeVersion: string;
  platform: string;
  architecture: string;
  providerId: string;
  providerName: string;
  apiKey: string;
  apiKeyFound: boolean;
  models: Array<{ provider: string; model: string }>;
  clientsChecked: DoctorClient[];
  claudeFound: boolean;
  codexFound: boolean;
  portAvailable: boolean;
  networkChecksSkipped: boolean;
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

function parseClient(value: string | undefined): DoctorClient {
  if (value === "claude" || value === "codex" || value === "all") return value;
  return "all";
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const { client: _client, offline: _offline, ...raw } = options;
  const config = loadConfig(raw as Record<string, string | undefined>);
  const wsl = Boolean(process.env.WSL_INTEROP);
  const provider = providerById(config.provider ?? "opencode");
  const apiKey = config.apiKey || storedCredential(provider) || "";
  const clientsChecked: DoctorClient[] = [parseClient(options.client)];
  const networkChecksSkipped = Boolean(options.offline);
  const issues: string[] = [];
  if (!apiKey) issues.push(`Set ${credentialEnvName(provider)} (or ${provider.apiKeyEnv}) before starting the adapter, or pass --api-key <key>.`);
  const checkClaude = clientsChecked[0] === "all" || clientsChecked[0] === "claude";
  const checkCodex = clientsChecked[0] === "all" || clientsChecked[0] === "codex";
  const claudeFound = checkClaude ? await executableExists("claude") : true;
  const codexFound = checkCodex ? await executableExists("codex") : true;
  if (checkClaude && !claudeFound) issues.push("Claude Code was not found. Install Claude Code and ensure `claude` is on PATH.");
  if (checkCodex && !codexFound) issues.push("Codex was not found. Install Codex and ensure `codex` is on PATH if you plan to use it.");
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
    clientsChecked,
    claudeFound,
    codexFound,
    portAvailable: available,
    networkChecksSkipped,
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
  if (result.networkChecksSkipped) lines.push("  (network checks skipped via --offline)");
  lines.push("");
  lines.push("Provider");
  lines.push(`  ${ok(true)} Provider     ${result.providerName}`);
  lines.push(`  ${ok(result.apiKeyFound)} API key      ${result.apiKeyFound ? "found" : "missing"}`);
  lines.push("");
  lines.push("Models");
  for (const model of result.models) lines.push(`  ${ok(true)} ${model.provider}/${model.model}`);
  lines.push("");
  const checkingAll = result.clientsChecked[0] === "all";
  if (checkingAll || result.clientsChecked[0] === "claude") {
    lines.push(`  ${ok(result.claudeFound)} Claude Code  ${result.claudeFound ? "found" : "not found"}`);
  }
  if (checkingAll || result.clientsChecked[0] === "codex") {
    lines.push(`  ${ok(result.codexFound)} Codex         ${result.codexFound ? "found" : "not found"}`);
  }
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
