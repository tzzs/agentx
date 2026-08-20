#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startAdapter } from "./server.js";
import { runCommand } from "./process.js";
import { selectableProviders, selectModel } from "./ui.js";
import { providerById } from "./providers/registry.js";
import { runDoctor, renderDoctor } from "./doctor.js";
import { credentialStoreAvailable, deleteCredential, promptAndSaveCredential, resolveCredential, storedCredential } from "./credentials.js";
import { loadLastProfile, saveProfile } from "./profiles.js";
import { queryProviderUsage, usageProvider } from "./usage.js";

const HELP: Record<string, string> = {
  claude: "Start the local adapter and Claude Code together",
  codex: "Start the local adapter and Codex together",
  pi: "Launch Pi Agent through the OpenAI-compatible local environment",
  proxy: "Start only the local adapter",
  exec: "Run any command with the temporary Anthropic environment",
  auth: "Manage stored provider credentials",
  usage: "Query provider quota",
  doctor: "Inspect the local environment and configuration",
  version: "Print the CLI version",
};

function helpText(command?: string): string {
  const lines: string[] = [];
  if (command && HELP[command]) {
    lines.push(`agentx ${command} - ${HELP[command]}`);
    lines.push("");
    if (command === "auth") {
      lines.push("Usage: agentx auth <login|status|logout> --provider <provider>");
    } else if (command === "usage") {
      lines.push("Usage: agentx usage --provider <provider>");
    } else if (command === "exec") {
      lines.push("Usage: agentx exec [options] -- <command> [args...]");
    } else {
      lines.push(`Usage: agentx ${command} [options]`);
    }
    lines.push("");
    lines.push("Options:");
    lines.push("  --provider <id>     Upstream provider (opencode, deepseek, openrouter)");
    lines.push("  --model <model>     Model or auto");
    lines.push("  --port <port>       Preferred local port (default 8787)");
    lines.push("  --host <host>       Local bind address (default 127.0.0.1)");
    lines.push("  --api-key <key>     Upstream API key");
    lines.push("  --verbose           Verbose logging");
    return lines.join("\n");
  }
  lines.push("agentx - Local Anthropic/OpenAI-compatible adapter for OpenCode Go");
  lines.push("");
  lines.push("Usage: agentx <command> [options]");
  lines.push("");
  lines.push("Commands:");
  for (const [name, description] of Object.entries(HELP)) {
    lines.push(`  ${name.padEnd(9)} ${description}`);
  }
  lines.push("");
  lines.push("Global options:");
  lines.push("  --provider <id>     Upstream provider (opencode, deepseek, openrouter)");
  lines.push("  --model <model>     Model or auto");
  lines.push("  --port <port>       Preferred local port (default 8787)");
  lines.push("  --host <host>       Local bind address (default 127.0.0.1)");
  lines.push("  --api-key <key>     Upstream API key");
  lines.push("  --verbose           Verbose logging");
  lines.push("");
  lines.push("Run 'agentx help <command>' for details on a command.");
  return lines.join("\n");
}

function options(args: string[]) { const out: Record<string, string | undefined> = {}; for (let i = 0; i < args.length; i++) { const key = args[i]; if (key?.startsWith("--")) out[key.slice(2)] = args[++i]; } return out; }
async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
if (command === "version") return console.log("1.0.0");
  if (command === "help" || command === "--help" || command === "-h") return console.log(helpText(args[0]));
  if (command === "auth") {
    const action = args[0] ?? "status"; const provider = providerById(options(args).provider ?? process.env.AGENTX_PROVIDER ?? "opencode");
    if (action === "login") { await promptAndSaveCredential(provider); console.log(`Saved credentials for ${provider.id}.`); return; }
    if (action === "logout") { if (!(await deleteCredential(provider))) console.log("Secure credential storage is unavailable."); else console.log(`Removed credentials for ${provider.id}.`); return; }
    if (action === "status") { console.log(`Provider: ${provider.name}\nCredential store: ${credentialStoreAvailable() ? "available" : "unavailable"}\nCredential: ${(await storedCredential(provider)) ? "configured" : "missing"}`); return; }
    throw new Error("Usage: agentx auth <login|status|logout> --provider <provider>");
  }
  if (command === "usage") {
    const provider = usageProvider(options(args).provider); const key = provider.id === "opencode" ? "" : await resolveCredential(provider);
    const result = await queryProviderUsage(provider.id, key); console.log(JSON.stringify(result, null, 2)); if (!result.success && result.supported) process.exitCode = 1; return;
  }
  if (command === "doctor") {
    const result = await runDoctor(options(args));
    console.log(renderDoctor(result));
    if (result.issues.length) process.exitCode = 1;
    return;
  }
  const opts = options(args);
  const clientCommand = command === "claude" || command === "codex" ? command : undefined;
  if (clientCommand && opts.model === undefined && !process.env.AGENTX_MODEL) { const choices = selectableProviders(clientCommand); const remembered = loadLastProfile(); const preselect = choices.find((choice) => remembered && choice.model === remembered.model && choice.provider === remembered.provider); const selected = await selectModel(clientCommand, choices, preselect); opts.model = selected.model; opts.provider = selected.provider; }
  const config = loadConfig(opts); const selectedProvider = providerById(config.provider ?? "opencode"); config.apiKey = await resolveCredential(selectedProvider, config.apiKey);
  await saveProfile({ id: `${selectedProvider.id}/${config.model}`, provider: selectedProvider.id, model: config.model, displayName: `${selectedProvider.name} / ${config.model}`, clientModels: { claude: config.model, codex: config.model } });
  const adapter = await startAdapter(config);
  console.error(`AgentX\n✓ Client: ${command === "codex" ? "Codex" : command === "claude" ? "Claude Code" : "command"}\n✓ Provider: ${config.provider ?? "opencode"}\n✓ Adapter started on ${config.host}:${adapter.port}\n✓ Model: ${config.model}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") console.error("Warning: Adapter will be accessible from the network.");
  if (command === "proxy") { console.error("Press Ctrl+C to stop."); await new Promise<void>((resolve) => { const close = async () => { await adapter.close(); resolve(); }; process.once("SIGINT", close); process.once("SIGTERM", close); }); return; }
  const separator = args.indexOf("--"); const adapterFlags = new Set(["--model", "--provider", "--port", "--host", "--api-key", "--verbose"]); const commandArgs = separator >= 0 ? args.slice(separator + 1) : command === "claude" ? args.filter((arg, index) => !adapterFlags.has(arg) && !adapterFlags.has(args[index - 1] ?? "")) : [];
const executable = command === "claude" ? "claude" : command === "codex" ? "codex" : command === "pi" ? "pi" : command === "exec" ? commandArgs.shift() : undefined;
  if (!executable) throw new Error("Usage: agentx exec [options] -- <command>");
  const client = command === "codex" || executable === "codex" || command === "pi" || executable === "pi" ? "openai" : "anthropic";
  const launchArgs = executable === "claude" && !commandArgs.includes("--bare") ? ["--bare", ...commandArgs] : commandArgs;
  try { process.exitCode = await runCommand(executable, launchArgs, config, adapter, client); } finally { await adapter.close(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
