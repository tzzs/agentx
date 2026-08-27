#!/usr/bin/env node
import { loadConfig, parseCliOptions as options } from "./config.js";
import type { Config } from "./config.js";
import { startAdapter, type Adapter } from "./server.js";
import { runCommand, runShellCommand, ClientNotFoundError, CLIENT_INSTALL_COMMANDS, codexLaunchArgs } from "./process.js";
import { runInteractiveLauncher, runSavedModelManager, LaunchCancelledError } from "./ui.js";
import { credentialEnvName, providerById, refreshProviderCatalog, fetchOpenRouterModels, hydrateOpenRouterCatalog, openRouterCatalogIds, providerDisplayName } from "./providers/registry.js";
import type { ProviderDefinition } from "./providers/types.js";
import { runDoctor, renderDoctor, executableExists } from "./doctor.js";
import { credentialInstructions, credentialSource, promptCredential, resolveCredential } from "./credentials.js";
import { queryProviderUsage, usageProvider } from "./quota.js";
import { runUsageStats } from "./usage/cli.js";
import { resolveRuntimeNonInteractive } from "./selection.js";
import { loadLastSelection, remembererProviders, rememberedModelIds, saveLastModel, saveOpenRouterModels } from "./runtime.js";
import { catalogModels, writeCodexCatalog } from "./codex-catalog.js";
import { confirm, isCancel } from "@clack/prompts";

const HELP: Record<string, string> = {
  claude: "Start the local adapter and Claude Code together",
  codex: "Start the local adapter and Codex together",
  pi: "Launch Pi Agent through the OpenAI-compatible local environment",
  proxy: "Start only the local adapter",
  exec: "Run any command with the temporary Anthropic environment",
  auth: "Manage stored provider credentials",
  usage: "Show token usage statistics or query provider quota",
  doctor: "Inspect the local environment and configuration",
  forget: "Scrub saved model ids that upstream no longer offers",
  version: "Print the CLI version",
};

/** Option reference shared by per-command and global help output. */
const OPTION_LINES = [
  "  --provider <id>     Upstream provider (opencode, deepseek, openrouter)",
  "  --model <model>     Model or auto",
  "  --background-model <id>  Model for Claude Code's haiku/background tier (default: same as --model)",
  "  --port <port>       Preferred local port (default 8787)",
  "  --host <host>       Local bind address (default 127.0.0.1)",
  "  --api-key <key>     Upstream API key",
  "  --verbose           Verbose logging",
];

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
      return lines.join("\n");
    } else if (command === "doctor") {
      lines.push("Usage: agentx doctor [options]");
      lines.push("Options:");
      lines.push("  --client <name>     Limit checks to one client (claude, codex, all; default all)");
      lines.push("  --offline           Skip network-dependent checks");
      lines.push(...OPTION_LINES);
      return lines.join("\n");
    } else if (command === "exec") {
      lines.push("Usage: agentx exec [options] -- <command> [args...]");
    } else {
      lines.push(`Usage: agentx ${command} [options]`);
    }
    lines.push("");
    lines.push("Options:");
    lines.push(...OPTION_LINES);
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
  lines.push(...OPTION_LINES);
  lines.push("");
  lines.push("Run 'agentx help <command>' for details on a command.");
  return lines.join("\n");
}

const CLIENT_COMMANDS = new Set(["claude", "codex", "pi"]);

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Flags the adapter consumes itself; never forwarded to the launched client. */
const ADAPTER_FLAGS = new Set(["--model", "--background-model", "--provider", "--port", "--host", "--api-key", "--verbose"]);

/**
 * Strip adapter flags from `agentx claude ...` arguments so the client only
 * sees its own options. Both `--flag value` and inline `--flag=value` forms
 * are removed; a bare `--verbose` is boolean-ish and consumes nothing.
 */
export function clientArguments(args: string[]): string[] {
  const isAdapterFlag = (arg: string) => ADAPTER_FLAGS.has(arg) || (arg.startsWith("--") && arg.includes("=") && ADAPTER_FLAGS.has(`--${arg.slice(2).split("=", 1)[0]}`));
  const valueTaken = new Set<number>();
  args.forEach((arg, index) => { if (ADAPTER_FLAGS.has(arg) && arg !== "--verbose" && args[index + 1] !== undefined && !args[index + 1].startsWith("--")) valueTaken.add(index + 1); });
  return args.filter((arg, index) => !isAdapterFlag(arg) && !valueTaken.has(index));
}

/** Prompt for a missing provider credential. Returns the key when obtained. */
async function configureMissingProvider(provider: ProviderDefinition): Promise<string | undefined> {
  console.error(`${provider.name} is not configured.\n\nAPI key required.`);
  try {
    const key = await promptCredential(provider);
    console.error(`✓ ${provider.name} connected`);
    return key;
  } catch {
    return undefined;
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
      apiKey: undefined,
    };
  }
  const initial = await resolveRuntimeNonInteractive(command, opts);
  const outcome = await runInteractiveLauncher(command, initial);
  return {
    provider: outcome.provider,
    model: outcome.model,
    defaultApplied: outcome.defaultApplied,
    interactive: true,
    apiKey: outcome.apiKey,
  };
}

const CLIENT_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

/** Print a clear explanation for a client executable that could not be spawned. */
function reportMissingClient(executable: string): void {
  const label = CLIENT_LABELS[executable] ?? `"${executable}"`;
  console.error(`\n✗ ${label} not found: the "${executable}" command is not installed or not on PATH.`);
  const installCommand = CLIENT_INSTALL_COMMANDS[executable];
  if (installCommand) {
    console.error(`\nRecommended fix:\n  ${installCommand}\n\nAfter installing, re-run: agentx ${executable}`);
  } else {
    console.error("\nFix: install it and make sure it is available on PATH.");
  }
}

/**
 * Launch a client, with a recovery path for a missing executable: explain the
 * problem, and — interactively only — offer to run the known install command.
 * After a confirmed, successful install (verified by spawning the binary),
 * retry the launch; otherwise exit with a clear message. The adapter stays up
 * throughout so a successful install flows straight into the client session.
 */
async function launchClient(executable: string, args: string[], config: Config, adapter: Adapter, client: "anthropic" | "openai"): Promise<number> {
  try {
    return await runCommand(executable, args, config, adapter, client);
  } catch (error) {
    if (!(error instanceof ClientNotFoundError)) throw error;
    reportMissingClient(executable);
    const installCommand = CLIENT_INSTALL_COMMANDS[executable];
    if (!isInteractive() || !installCommand) { process.exitCode = 1; return 1; }
    const proceed = await confirm({ message: `Run \`${installCommand}\` now?`, initialValue: false });
    if (isCancel(proceed) || !proceed) {
      console.error(`Skipped installation. Re-run agentx ${executable} once installed.`);
      process.exitCode = 1;
      return 1;
    }
    console.error(`Running: ${installCommand}`);
    const code = await runShellCommand(installCommand);
    if (code !== 0 || !(await executableExists(executable))) {
      console.error("✗ Installation did not complete or the executable is still missing.\n  Install it manually, then re-run this command.");
      process.exitCode = 1;
      return 1;
    }
    console.error(`✓ ${CLIENT_LABELS[executable] ?? executable} installed`);
    return runCommand(executable, args, config, adapter, client);
  }
}

/**
 * Non-interactive `forget`: print every saved model id that upstream no longer
 * lists, without prompting. Perfect for `agentx forget` in scripts or before
 * launch to learn which remembered ids went stale.
 */
async function printStaleSavedModels(): Promise<void> {
  const catalog = openRouterCatalogIds();
  const providers = await remembererProviders();
  if (!providers.length) { console.log("No saved models recorded."); return; }
  let stale = 0;
  for (const { provider } of providers) {
    const ids = await rememberedModelIds(provider);
    const removed = ids.filter((model) => !catalog.includes(model));
    if (!removed.length) continue;
    console.log(`${providerDisplayName(provider)}:`);
    for (const model of removed) console.log(`  ${model}  (no longer in the catalog)`);
    stale += removed.length;
  }
  if (!stale) console.log("All saved models are still offered upstream.");
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "version") return console.log("1.0.0");
  if (command === "help" || command === "--help" || command === "-h") return console.log(helpText(args[0]));

  if (command === "auth") {
    const action = args[0] ?? "status";
    const provider = providerById(options(args).provider ?? process.env.AGENTX_PROVIDER ?? "opencode");
    if (action === "login") { console.log(credentialInstructions(provider)); return; }
    if (action === "logout") { console.log(`AgentX keeps provider API keys in environment variables and stores nothing itself.\nRemove ${credentialEnvName(provider)} (or ${provider.apiKeyEnv}) from your shell profile to sign out.`); return; }
    if (action === "status") { const source = credentialSource(provider); console.log(`Provider: ${provider.name}\nCredential: ${source ? `configured via ${source}` : "missing"}\nPreferred variable: ${credentialEnvName(provider)} (${provider.apiKeyEnv} also accepted)`); return; }
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
    const doctorOptions = options(args);
    await refreshProviderCatalog({ provider: doctorOptions.provider ?? process.env.AGENTX_PROVIDER });
    const result = await runDoctor({
      ...doctorOptions,
      client: doctorOptions.client === "claude" || doctorOptions.client === "codex" || doctorOptions.client === "all" ? doctorOptions.client : undefined,
      offline: doctorOptions.offline === "true" || doctorOptions.offline === "" ? true : undefined,
    });
    console.log(renderDoctor(result));
    if (result.issues.length) process.exitCode = 1;
    return;
  }

  if (command === "forget") {
    // Hydrate from disk first so a failed live fetch below still falls back
    // to the last-known-good catalog instead of an empty in-memory one.
    await hydrateOpenRouterCatalog();
    // Screen saved ids against the live catalog so removed ones surface first.
    // Failure still lets the manager run from the persisted catalog.
    const catalog = await fetchOpenRouterModels().catch(() => openRouterCatalogIds());
    await saveOpenRouterModels(catalog);
    if (!isInteractive()) {
      await printStaleSavedModels();
      return;
    }
    await runSavedModelManager();
    return;
  }

  const opts = options(args);
  if (CLIENT_COMMANDS.has(command)) {
    // The launcher needs the OpenCode catalog when the provider is not yet known.
    await refreshProviderCatalog({ provider: opts.provider ?? process.env.AGENTX_PROVIDER });
    const runtime = await resolveClientRuntime(command, opts);
    opts.provider = runtime.provider;
    opts.model = runtime.model;
    if (runtime.apiKey) opts.apiKey = runtime.apiKey;
    await saveLastModel(runtime.provider, runtime.model);
  } else if (command === "proxy" || command === "exec") {
    const lastSelection = await loadLastSelection();
    await refreshProviderCatalog({ provider: opts.provider ?? process.env.AGENTX_PROVIDER ?? lastSelection?.provider });
  }

  const lastSelection = CLIENT_COMMANDS.has(command)
    ? undefined
    : command === "proxy" || command === "exec"
      ? await loadLastSelection()
      : undefined;
  const config = loadConfig(opts, lastSelection);
  const selectedProvider = providerById(config.provider ?? "opencode");
  try {
    config.apiKey = await resolveCredential(selectedProvider, config.apiKey);
  } catch (error) {
    // Missing API key: offer a recovery flow instead of a bare error.
    if (isInteractive() && error instanceof Error && /API key not found/i.test(error.message)) {
      config.apiKey = (await configureMissingProvider(selectedProvider)) ?? "";
    } else {
      throw error;
    }
  }
  if (!config.apiKey) {
    console.error(`${selectedProvider.name} API key is required to start.\nConfigure it with:\n  agentx auth login --provider ${selectedProvider.id}\nor set ${credentialEnvName(selectedProvider)} (or ${selectedProvider.apiKeyEnv}) in non-interactive mode.`);
    process.exitCode = 1;
    return;
  }
  const adapter = await startAdapter(config);
  const clientLabel = command === "codex" ? "Codex" : command === "claude" ? "Claude Code" : command === "pi" ? "Pi" : "command";
  console.error(`AgentX\n✓ Client: ${clientLabel}\n✓ Provider: ${config.provider ?? "opencode"}\n✓ Adapter started on ${config.host}:${adapter.port}\n✓ Model: ${config.model}`);
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
  const commandArgs = separator >= 0
    ? args.slice(separator + 1)
    : CLIENT_COMMANDS.has(command)
      ? clientArguments(args)
      : [];

  const executable = command === "claude" ? "claude"
    : command === "codex" ? "codex"
      : command === "pi" ? "pi"
        : command === "exec" ? commandArgs.shift()
          : undefined;
  if (!executable) throw new Error("Usage: agentx exec [options] -- <command>");

  const client = command === "codex" || executable === "codex" || command === "pi" || executable === "pi" ? "openai" : "anthropic";
  let codexCatalogFile: string | undefined;
  if (executable === "codex") {
    // Codex needs external context/output limits only now; other launch paths
    // skip both metadata requests and catalog writing entirely.
    await refreshProviderCatalog({ provider: config.provider, metadata: true });
    codexCatalogFile = await writeCodexCatalog(catalogModels(config));
  }
  const launchArgs = executable === "claude" && !commandArgs.includes("--bare") ? ["--bare", ...commandArgs]
    : executable === "codex" ? [...codexLaunchArgs(config, adapter, codexCatalogFile), ...commandArgs]
      : commandArgs;

  try {
    process.exitCode = await launchClient(executable, launchArgs, config, adapter, client);
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