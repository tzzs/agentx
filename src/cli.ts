#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startAdapter } from "./server.js";
import { runCommand } from "./process.js";
import { providers } from "./catalog.js";
import { selectableProviders, selectModel } from "./ui.js";
import { providerById } from "./providers/registry.js";
import { resolveCredential } from "./credentials.js";
import { saveProfile } from "./profiles.js";

function options(args: string[]) { const out: Record<string, string | undefined> = {}; for (let i = 0; i < args.length; i++) { const key = args[i]; if (key?.startsWith("--")) out[key.slice(2)] = args[++i]; } return out; }
async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "version") return console.log("0.1.0");
  if (command === "help") return console.log("Usage: agentx <claude|codex|proxy|exec|doctor> [options]");
  if (command === "doctor") {
    const config = loadConfig(options(args)); const wsl = Boolean(process.env.WSL_INTEROP); const provider = providerById(config.provider ?? "opencode"); const keyFound = Boolean(config.apiKey || process.env[provider.apiKeyEnv]);
    console.log(`AgentX Doctor\nNode.js        ${process.version}\nPlatform       ${wsl ? "WSL" : process.platform}\nArchitecture   ${process.arch}\nProvider       ${provider.name}\nAPI key        ${keyFound ? "found" : "missing"}\nModels         ${providers.map((item) => `${item.provider}/${item.model}`).join(", ")}\nClaude Code    ${await executableExists("claude") ? "found" : "not found"}\nCodex          ${await executableExists("codex") ? "found" : "not found"}`);
    if (!keyFound) { console.log(`\nSet ${provider.apiKeyEnv} before starting the adapter.`); process.exitCode = 1; }
    return;
  }
  const opts = options(args);
  const clientCommand = command === "claude" || command === "codex" ? command : undefined;
  if (clientCommand && opts.model === undefined && !process.env.AGENTX_MODEL) { const selected = await selectModel(clientCommand, selectableProviders(clientCommand)); opts.model = selected.model; opts.provider = selected.provider; }
  const config = loadConfig(opts); const selectedProvider = providerById(config.provider ?? "opencode"); config.apiKey = await resolveCredential(selectedProvider, config.apiKey);
  await saveProfile({ id: `${selectedProvider.id}/${config.model}`, provider: selectedProvider.id, model: config.model, displayName: `${selectedProvider.name} / ${config.model}`, clientModels: { claude: config.model, codex: config.model } });
  const adapter = await startAdapter(config);
  console.error(`AgentX\n✓ Client: ${command === "codex" ? "Codex" : command === "claude" ? "Claude Code" : "command"}\n✓ Provider: ${config.provider ?? "opencode"}\n✓ Adapter started on ${config.host}:${adapter.port}\n✓ Model: ${config.model}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") console.error("Warning: Adapter will be accessible from the network.");
  if (command === "proxy") { console.error("Press Ctrl+C to stop."); await new Promise<void>((resolve) => { const close = async () => { await adapter.close(); resolve(); }; process.once("SIGINT", close); process.once("SIGTERM", close); }); return; }
  const separator = args.indexOf("--"); const adapterFlags = new Set(["--model", "--provider", "--port", "--host", "--api-key", "--verbose"]); const commandArgs = separator >= 0 ? args.slice(separator + 1) : command === "claude" ? args.filter((arg, index) => !adapterFlags.has(arg) && !adapterFlags.has(args[index - 1] ?? "")) : [];
  const executable = command === "claude" ? "claude" : command === "codex" ? "codex" : command === "exec" ? commandArgs.shift() : undefined;
  if (!executable) throw new Error("Usage: agentx exec [options] -- <command>");
  const client = command === "codex" || executable === "codex" ? "openai" : "anthropic";
  const launchArgs = executable === "claude" && !commandArgs.includes("--bare") ? ["--bare", ...commandArgs] : commandArgs;
  try { process.exitCode = await runCommand(executable, launchArgs, config, adapter, client); } finally { await adapter.close(); }
}
async function executableExists(command: string) { try { const child = (await import("node:child_process")).spawn(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" }); return await new Promise<boolean>((resolve) => { child.once("error", () => resolve(false)); child.once("exit", (code) => resolve(code === 0)); }); } catch { return false; } }
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
