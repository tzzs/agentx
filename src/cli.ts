#!/usr/bin/env node
import { loadConfig, parseCliOptions as options } from "./config.js";
import { startAdapter } from "./server.js";
import { runCommand } from "./process.js";
import { runInteractiveLauncher, LaunchCancelledError } from "./ui.js";
import { providerById, refreshOpenCodeModels } from "./providers/registry.js";
import type { ProviderDefinition } from "./providers/types.js";
import { runDoctor, renderDoctor } from "./doctor.js";
import { credentialStoreAvailable, deleteCredential, promptAndSaveCredential, resolveCredential, storedCredential } from "./credentials.js";
import { saveProfile } from "./profiles.js";
import { queryProviderUsage, usageProvider } from "./quota.js";
import { runUsageStats } from "./usage/cli.js";
import { resolveRuntimeNonInteractive } from "./selection.js";
import { saveLastModel } from "./runtime.js";

const HELP: Record<string, string> = {
  claude: "Start the local adapter and Claude Code together",
  codex: "Start the local adapter and Codex together",
  pi: "Launch Pi Agent through the OpenAI-compatible local environment",
  proxy: "Start only the local adapter",
  exec: "Run any command with the temporary Anthropic environment",
  auth: "Manage stored provider credentials",
  usage: "Show token usage statistics or query provider quota",
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
      lines.push("Usage: agentx usage [--period today|week|month|all]");
      lines.push("       agentx usage --provider <provider>");
      lines.push("Options:");
      lines.push("  --period <range>    Time range for token statistics (default all)");
      lines.push("  --provider <id>     Query provider quota instead of token statistics");
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
  lines.push("agentx - Local Anthropic/OpenAI-compatible adapter for OpenCode");
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

const CLIENT_COMMANDS = new Set(["claude", "codex", "pi"]);

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Prompt for a missing provider credential. Returns true when saved. */
async function configureMissingProvider(provider: ProviderDefinition): Promise<boolean> {
  console.error(`${provider.name} is not configured.\n\nAPI key required.`);
  try {
    await promptAndSaveCredential(provider);
    console.error(`✓ ${provider.name} connected`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the runtime for an agent client. A fully-specified model
 * (`--model` or `AGENTX_MODEL`) takes the automation path (no UI), matching the
 * historical behavior. Otherwise an interactive launcher shows the inline
 * configuration and lets the user switch provider / model without touching the
 * saved default. Specifying only a provider still reaches the launcher (with
 * that provider pre-selected), preserving compatibility.
 */
async function resolveClientRuntime(command: string, opts: Record<string, string | undefined>) {
  const hasExplicitModel = Boolean(opts.model || process.env.AGENTX_MODEL);
  if (hasExplicitModel || !isInteractive()) {
    const decision = await resolveRuntimeNonInteractive(command, opts);
    return {
      provider: decision.provider,
      model: decision.model,
      defaultApplied: decision.defaultApplied,
      interactive: false,
    };
  }
  const initial = await resolveRuntimeNonInteractive(command, opts);
  const outcome = await runInteractiveLauncher(command, initial);
  return {
    provider: outcome.provider,
    model: outcome.model,
    defaultApplied: outcome.defaultApplied,
    interactive: true,
  };
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "version") return console.log("1.0.0");
  if (command === "help" || command === "--help" || command === "-h") return console.log(helpText(args[0]));

  if (command === "auth") {
    const action = args[0] ?? "status";
    const provider = providerById(options(args).provider ?? process.env.AGENTX_PROVIDER ?? "opencode");
    if (action === "login") { await promptAndSaveCredential(provider); console.log(`Saved credentials for ${provider.name}.`); return; }
    if (action === "logout") { if (!(await deleteCredential(provider))) console.log("Secure credential storage is unavailable."); else console.log(`Removed credentials for ${provider.name}.`); return; }
    if (action === "status") { console.log(`Provider: ${provider.name}\nCredential store: ${credentialStoreAvailable() ? "available" : "unavailable"}\nCredential: ${(await storedCredential(provider)) ? "configured" : "missing"}`); return; }
    throw new Error("Usage: agentx auth <login|status|logout> --provider <provider>");
  }

  if (command === "usage") {
    const opts = options(args);
    if (!opts.provider && !process.env.AGENTX_PROVIDER) {
      const period = opts.period === "today" || opts.period === "week" || opts.period === "month" || opts.period === "all" ? opts.period : "all";
      console.log(await runUsageStats(period));
      return;
    }
    const provider = usageProvider(opts.provider); const key = provider.id === "opencode" ? "" : await resolveCredential(provider);
    const result = await queryProviderUsage(provider.id, key); console.log(JSON.stringify(result, null, 2)); if (!result.success && result.supported) process.exitCode = 1; return;
  }

  if (command === "doctor") {
    await refreshOpenCodeModels();
    const result = await runDoctor(options(args));
    console.log(renderDoctor(result));
    if (result.issues.length) process.exitCode = 1;
    return;
  }

  const opts = options(args);
  let usedDefault = false;
  let interactiveRuntime = false;
  if (CLIENT_COMMANDS.has(command)) {
    await refreshOpenCodeModels();
    const runtime = await resolveClientRuntime(command, opts);
    opts.provider = runtime.provider;
    opts.model = runtime.model;
    usedDefault = runtime.defaultApplied;
    interactiveRuntime = runtime.interactive;
    if (runtime.model !== "auto") await saveLastModel(runtime.provider, runtime.model);
  } else if (command === "proxy" || command === "exec") {
    await refreshOpenCodeModels();
  }

  const config = loadConfig(opts);
  const selectedProvider = providerById(config.provider ?? "opencode");
  try {
    config.apiKey = await resolveCredential(selectedProvider, config.apiKey);
  } catch (error) {
    // Missing API key: offer a recovery flow instead of a bare error.
    if (isInteractive() && error instanceof Error && /API key not found/i.test(error.message)) {
      const configured = await configureMissingProvider(selectedProvider);
      config.apiKey = configured ? await resolveCredential(selectedProvider) : "";
    } else {
      throw error;
    }
  }
  if (!config.apiKey) {
    console.error(`${selectedProvider.name} API key is required to start.\nConfigure it with:\n  agentx auth login --provider ${selectedProvider.id}\nor set ${selectedProvider.apiKeyEnv} in non-interactive mode.`);
    process.exitCode = 1;
    return;
  }
  await saveProfile({
    id: `${selectedProvider.id}/${config.model}`,
    provider: selectedProvider.id,
    model: config.model,
    displayName: `${selectedProvider.name} / ${config.model}`,
    clientModels: { claude: config.model, codex: config.model },
  });

  const adapter = await startAdapter(config);
  const clientLabel = command === "codex" ? "Codex" : command === "claude" ? "Claude Code" : command === "pi" ? "Pi" : "command";
  const runtimeNote = usedDefault || !interactiveRuntime ? "" : "\nRuntime: temporary selection (saves only with \"Set as default\")";
  console.error(`AgentX\n✓ Client: ${clientLabel}\n✓ Provider: ${config.provider ?? "opencode"}\n✓ Adapter started on ${config.host}:${adapter.port}\n✓ Model: ${config.model}${runtimeNote}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") console.error("Warning: Adapter will be accessible from the network.");

  if (command === "proxy") {
    console.error("Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const close = async () => { await adapter.close(); resolve(); };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return;
  }

  const separator = args.indexOf("--");
  const adapterFlags = new Set(["--model", "--provider", "--port", "--host", "--api-key", "--verbose"]);
  const commandArgs = separator >= 0
    ? args.slice(separator + 1)
    : command === "claude"
      ? args.filter((arg, index) => !adapterFlags.has(arg) && !adapterFlags.has(args[index - 1] ?? ""))
      : [];

  const executable = command === "claude" ? "claude"
    : command === "codex" ? "codex"
      : command === "pi" ? "pi"
        : command === "exec" ? commandArgs.shift()
          : undefined;
  if (!executable) throw new Error("Usage: agentx exec [options] -- <command>");

  const client = command === "codex" || executable === "codex" || command === "pi" || executable === "pi" ? "openai" : "anthropic";
  const launchArgs = executable === "claude" && !commandArgs.includes("--bare") ? ["--bare", ...commandArgs] : commandArgs;

  try {
    process.exitCode = await runCommand(executable, launchArgs, config, adapter, client);
  } finally {
    await adapter.close();
  }
}

main().catch((error) => {
  if (error instanceof LaunchCancelledError) { process.exitCode = error.exitCode; return; }
  const message = error instanceof Error ? error.message : error;
  console.error(message);
  process.exitCode = 1;
});