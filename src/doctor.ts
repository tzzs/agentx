import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { providerFor, providers } from "./catalog.js";
import { credentialEnvName, providerById } from "./providers/registry.js";
import { storedCredential } from "./credentials.js";
import type { ProviderModel } from "./providers/types.js";

/** Which client set the doctor should inspect. `"all"` keeps historical behavior. */
export type DoctorClient = "claude" | "codex" | "all";

/** Outcome of the upstream probe; `checked: false` means --offline skipped it. */
export interface UpstreamCheck {
  checked: boolean;
  reachable: boolean;
  authorized: boolean;
  message?: string;
}

export interface DoctorOptions {
  client?: DoctorClient;
  offline?: boolean;
  /** Injection seam: tests exercise the online path without touching the network. */
  fetcher?: typeof fetch;
  /** Other flags (provider, port, host, api-key, …) flow through to loadConfig. */
  [key: string]: string | undefined | boolean | DoctorClient | typeof fetch;
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
  upstream: UpstreamCheck;
  issues: string[];
}

/**
 * The model-list URL beside a provider's request endpoint. All three
 * protocols serve their model list next to the request path —
 * `…/chat/completions`, `…/responses` and `…/messages` each sit beside
 * `…/models` — so replacing the known suffix is enough.
 */
export function modelListUrl(endpoint: string): string {
  const replaced = endpoint.replace(/\/(?:chat\/completions|responses|messages)\/?$/, "/models");
  // An endpoint with an unexpected shape still gets a best-effort sibling path.
  return replaced === endpoint ? endpoint.replace(/\/[^/]*$/, "/models") : replaced;
}

/**
 * Probe the configured upstream: is the endpoint reachable, and does the key
 * work? This is the check `doctor` was missing — it could report that a key
 * was *found*, never that it was *accepted*, and a rejected key is the most
 * common reason a launch fails.
 */
export async function checkUpstream(provider: ProviderModel, apiKey: string, fetcher: typeof fetch = fetch): Promise<UpstreamCheck> {
  if (!apiKey) return { checked: true, reachable: false, authorized: false, message: "skipped — no API key to test" };
  const url = modelListUrl(provider.endpoint);
  try {
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${apiKey}`, ...provider.headers };
    if (provider.protocol === "anthropic") { headers["x-api-key"] = apiKey; headers["anthropic-version"] = "2023-06-01"; }
    const response = await fetcher(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (response.status === 401 || response.status === 403) return { checked: true, reachable: true, authorized: false, message: `rejected the API key (HTTP ${response.status})` };
    if (!response.ok) return { checked: true, reachable: true, authorized: true, message: `reachable, but the model list returned HTTP ${response.status}` };
    return { checked: true, reachable: true, authorized: true };
  } catch (error) {
    return { checked: true, reachable: false, authorized: false, message: error instanceof Error ? error.message : "unreachable" };
  }
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
  const { client: _client, offline: _offline, fetcher, ...raw } = options;
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
  let upstream: UpstreamCheck = { checked: false, reachable: false, authorized: false };
  if (!networkChecksSkipped) {
    // providerFor throws for a provider whose model list is empty or unknown;
    // a doctor run must still report everything else it learned.
    try { upstream = await checkUpstream(providerFor(config.model, config.provider), apiKey, fetcher as typeof fetch | undefined); }
    catch (error) { upstream = { checked: true, reachable: false, authorized: false, message: error instanceof Error ? error.message : "could not resolve the configured model" }; }
    if (upstream.checked && !upstream.reachable && apiKey) issues.push(`${provider.name} is not reachable (${upstream.message ?? "unknown error"}). Check the network or the endpoint.`);
    if (upstream.checked && upstream.reachable && !upstream.authorized) issues.push(`${provider.name} ${upstream.message}. Set a valid key in ${credentialEnvName(provider)} or pass --api-key <key>.`);
  }
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
    upstream,
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
  if (result.upstream.checked) {
    const healthy = result.upstream.reachable && result.upstream.authorized;
    const detail = result.upstream.message ?? (healthy ? "reachable, key accepted" : "unavailable");
    lines.push(`  ${ok(healthy)} Upstream      ${detail}`);
  }
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
