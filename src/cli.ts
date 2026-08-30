#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig, parseCliOptions as options } from "./config.js";
import { startAdapter } from "./server.js";
import { runCommand, runShellCommand, ClientNotFoundError, CLIENT_INSTALL_COMMANDS, clientEnvironment, codexLaunchArgs, nativeClientEnvironment } from "./process.js";
import { runInteractiveLauncher, runSavedModelManager, LaunchCancelledError } from "./ui.js";
import { credentialEnvName, providerById, refreshProviderCatalog, fetchOpenRouterModels, hydrateOpenRouterCatalog, openRouterCatalogIds, providerDisplayName, registerCustomProvider, unregisterCustomProvider } from "./providers/registry.js";
import type { ProviderDefinition, ProviderProtocol } from "./providers/types.js";
import { runDoctor, renderDoctor, executableExists } from "./doctor.js";
import { credentialInstructions, credentialSource, promptCredential, resolveCredential } from "./credentials.js";
import { runQuotaCommand } from "./quota.js";
import { runUsageStats } from "./usage/cli.js";
import { resolveRuntimeNonInteractive } from "./selection.js";
import { forgetCustomProvider, loadCustomProviders, loadLastSelection, remembererProviders, rememberedModelIds, saveCustomProvider, saveLastModel, saveOpenRouterModels } from "./runtime.js";
import { catalogModels, writeCodexCatalog } from "./codex-catalog.js";
import { confirm, isCancel } from "@clack/prompts";

const HELP: Record<string, string> = {
  claude: "Start the local adapter and Claude Code together",
  codex: "Start the local adapter and Codex together",
  proxy: "Start only the local adapter",
  exec: "Run any command with the temporary Anthropic environment",
  auth: "Manage stored provider credentials",
  usage: "Show token usage statistics",
  quota: "Query provider quota (remote account balance/limit)",
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
  "  --retry <n>         Retry attempts on upstream 429/5xx (default 3, 0 disables)",
  "  --client-protocol <anthropic|openai>  exec only: env vars to inject for the launched program (default anthropic)",
  "  --base-url <url>    Define (and persist) a custom provider at this endpoint; --provider names it",
  "  --protocol <responses|chat-completions|anthropic>  Upstream protocol for --base-url (default chat-completions)",
  "  --verbose           Verbose logging",
  "  --native            claude/codex only: launch the real client directly, no adapter or env overrides",
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
      lines.push("Options:");
      lines.push("  --period <range>    Time range for token statistics (default all)");
      lines.push("  --provider <id>     Deprecated: use `agentx quota --provider <id>` instead");
      return lines.join("\n");
    } else if (command === "quota") {
      lines.push("Usage: agentx quota --provider <provider>");
      lines.push("Options:");
      lines.push("  --provider <id>     Provider to query (default: opencode or AGENTX_PROVIDER)");
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
    } else if (command === "forget") {
      lines.push("Usage: agentx forget");
      lines.push("       agentx forget --provider <custom-id> --remove-provider");
      lines.push("Options:");
      lines.push("  --provider <id>     Scope to one provider (with --remove-provider, the custom provider to remove entirely)");
      lines.push("  --remove-provider   Remove the named custom provider instead of scrubbing stale model ids");
      return lines.join("\n");
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

const CLIENT_COMMANDS = new Set(["claude", "codex"]);

/**
 * Version reported by `agentx version`, read from package.json at the package
 * root. `import.meta.url` points at the compiled dist/src/cli.js, which sits
 * exactly two levels below that root both in the repo and in an installed
 * package, so the same relative URL resolves in both layouts.
 */
export function versionText(): string {
  try { return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version); }
  catch { return "0.0.0"; }
}

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Flags the adapter consumes itself; never forwarded to the launched client. */
const ADAPTER_FLAGS = new Set(["--model", "--background-model", "--provider", "--port", "--host", "--api-key", "--retry", "--client-protocol", "--base-url", "--protocol", "--verbose", "--native"]);
/** Boolean-ish adapter flags that never consume the following argument as a value. */
const BOOLEAN_ADAPTER_FLAGS = new Set(["--verbose", "--native"]);

/**
 * Strip adapter flags from `agentx claude ...` arguments so the client only
 * sees its own options. Both `--flag value` and inline `--flag=value` forms
 * are removed; a bare `--verbose` / `--native` is boolean-ish and consumes nothing.
 */
export function clientArguments(args: string[]): string[] {
  const isAdapterFlag = (arg: string) => ADAPTER_FLAGS.has(arg) || (arg.startsWith("--") && arg.includes("=") && ADAPTER_FLAGS.has(`--${arg.slice(2).split("=", 1)[0]}`));
  const valueTaken = new Set<number>();
  args.forEach((arg, index) => { if (ADAPTER_FLAGS.has(arg) && !BOOLEAN_ADAPTER_FLAGS.has(arg) && args[index + 1] !== undefined && !args[index + 1].startsWith("--")) valueTaken.add(index + 1); });
  return args.filter((arg, index) => !isAdapterFlag(arg) && !valueTaken.has(index));
}

/** True when `--native` (or `--native=...` truthy form) was passed. */
function isNativeRequested(opts: Record<string, string | undefined>): boolean {
  return opts.native !== undefined && opts.native !== "false";
}

/** Prompt for a missing provider credential. Returns the key when obtained. */
export async function configureMissingProvider(provider: ProviderDefinition, deps: { promptCredential?: typeof promptCredential } = {}): Promise<string | undefined> {
  const prompt = deps.promptCredential ?? promptCredential;
  console.error(`${provider.name} is not configured.\n\nAPI key required.`);
  try {
    const key = await prompt(provider);
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
      native: false,
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
    native: outcome.native ?? false,
  };
}

const CLIENT_LABELS: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

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

/** Injectable side effects for {@link launchClient}, so tests can exercise the install-recovery flow without a real terminal, shell, or spawned process. */
export interface ClientLaunchDeps {
  runCommand?: typeof runCommand;
  confirm?: typeof confirm;
  runShellCommand?: typeof runShellCommand;
  executableExists?: typeof executableExists;
}

/**
 * Launch a client, with a recovery path for a missing executable: explain the
 * problem, and — interactively only — offer to run the known install command.
 * After a confirmed, successful install (verified by spawning the binary),
 * retry the launch; otherwise exit with a clear message. The adapter stays up
 * throughout so a successful install flows straight into the client session.
 */
export async function launchClient(executable: string, args: string[], env: NodeJS.ProcessEnv, deps: ClientLaunchDeps = {}): Promise<number> {
  const run = deps.runCommand ?? runCommand;
  const confirmFn = deps.confirm ?? confirm;
  const runShell = deps.runShellCommand ?? runShellCommand;
  const exists = deps.executableExists ?? executableExists;
  try {
    return await run(executable, args, env);
  } catch (error) {
    if (!(error instanceof ClientNotFoundError)) throw error;
    reportMissingClient(executable);
    const installCommand = CLIENT_INSTALL_COMMANDS[executable];
    if (!isInteractive() || !installCommand) { process.exitCode = 1; return 1; }
    const proceed = await confirmFn({ message: `Run \`${installCommand}\` now?`, initialValue: false });
    if (isCancel(proceed) || !proceed) {
      console.error(`Skipped installation. Re-run agentx ${executable} once installed.`);
      process.exitCode = 1;
      return 1;
    }
    console.error(`Running: ${installCommand}`);
    const code = await runShell(installCommand);
    if (code !== 0 || !(await exists(executable))) {
      console.error("✗ Installation did not complete or the executable is still missing.\n  Install it manually, then re-run this command.");
      process.exitCode = 1;
      return 1;
    }
    console.error(`✓ ${CLIENT_LABELS[executable] ?? executable} installed`);
    return run(executable, args, env);
  }
}

/**
 * Non-interactive `forget`: print every saved OpenRouter model id that the
 * upstream no longer lists, without prompting. Perfect for `agentx forget` in
 * scripts or before launch to learn which remembered ids went stale. Only
 * OpenRouter ids are screened: its public catalog is the one machine-checkable
 * upstream listing, and it is vendor-prefixed — judging other providers' bare
 * ids (deepseek, opencode, custom endpoints) against it would report false
 * staleness for perfectly valid models.
 */
async function printStaleSavedModels(): Promise<void> {
  const catalog = openRouterCatalogIds();
  const providers = (await remembererProviders()).filter(({ provider }) => provider === "openrouter");
  if (!providers.length) { console.log("No saved OpenRouter models recorded."); return; }
  let stale = 0;
  for (const { provider } of providers) {
    const ids = await rememberedModelIds(provider);
    const removed = ids.filter((model) => !catalog.includes(model));
    if (!removed.length) continue;
    console.log(`${providerDisplayName(provider)}:`);
    for (const model of removed) console.log(`  ${model}  (no longer in the catalog)`);
    stale += removed.length;
  }
  if (!stale) console.log("All saved OpenRouter models are still offered upstream.");
}

export async function runAuthCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  const provider = providerById(options(args).provider ?? process.env.AGENTX_PROVIDER ?? "opencode");
  if (action === "login") { console.log(credentialInstructions(provider)); return; }
  if (action === "logout") { console.log(`AgentX keeps provider API keys in environment variables and stores nothing itself.\nRemove ${credentialEnvName(provider)} (or ${provider.apiKeyEnv}) from your shell profile to sign out.`); return; }
  if (action === "status") { const source = credentialSource(provider); console.log(`Provider: ${provider.name}\nCredential: ${source ? `configured via ${source}` : "missing"}\nPreferred variable: ${credentialEnvName(provider)} (${provider.apiKeyEnv} also accepted)`); return; }
  throw new Error("Usage: agentx auth <login|status|logout> --provider <provider>");
}

export async function runUsageCommand(args: string[]): Promise<void> {
  const opts = options(args);
  if (!opts.provider && !process.env.AGENTX_PROVIDER) {
    const period = opts.period === "today" || opts.period === "week" || opts.period === "month" || opts.period === "all" ? opts.period : "all";
    console.log(await runUsageStats(period));
    return;
  }
  console.error("Deprecated: use `agentx quota --provider <id>` instead.");
  const { output, exitCode } = await runQuotaCommand(opts.provider);
  console.log(output);
  process.exitCode = exitCode;
}

export async function runQuotaCliCommand(args: string[]): Promise<void> {
  const { output, exitCode } = await runQuotaCommand(options(args).provider);
  console.log(output);
  process.exitCode = exitCode;
}

export async function runDoctorCommand(args: string[]): Promise<void> {
  const doctorOptions = options(args);
  await refreshProviderCatalog({ provider: doctorOptions.provider ?? process.env.AGENTX_PROVIDER });
  const result = await runDoctor({
    ...doctorOptions,
    client: doctorOptions.client === "claude" || doctorOptions.client === "codex" || doctorOptions.client === "all" ? doctorOptions.client : undefined,
    offline: doctorOptions.offline === "true" || doctorOptions.offline === "" ? true : undefined,
  });
  console.log(renderDoctor(result));
  if (result.issues.length) process.exitCode = 1;
}

export async function runForgetCommand(args: string[]): Promise<void> {
  const opts = options(args);
  if (opts["remove-provider"]) {
    const id = opts.provider;
    if (!id) throw new Error("Usage: agentx forget --provider <custom-id> --remove-provider");
    // unregisterCustomProvider only touches custom entries — built-in
    // providers (and unknown ids) are refused rather than silently no-op'd.
    if (!unregisterCustomProvider(id)) {
      console.error(`"${id}" is not a custom provider; built-in providers cannot be removed.`);
      process.exitCode = 1;
      return;
    }
    await forgetCustomProvider(id);
    console.log(`Removed custom provider "${id}".`);
    return;
  }
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
}

/**
 * Resolve the executable to spawn, which env-var shape it expects, and its
 * positional arguments — for claude/codex/exec. exec launches an arbitrary
 * program, so it cannot infer which env-var shape the target expects from its
 * name the way claude/codex can; `--client-protocol` lets the caller say so
 * explicitly (default anthropic, matching prior behavior).
 */
function resolveLaunchTarget(command: string, args: string[], opts: Record<string, string | undefined>): { executable: string; client: "anthropic" | "openai"; commandArgs: string[] } {
  const separator = args.indexOf("--");
  const commandArgs = separator >= 0 ? args.slice(separator + 1) : CLIENT_COMMANDS.has(command) ? clientArguments(args) : [];
  let executable: string | undefined;
  if (command === "claude") executable = "claude";
  else if (command === "codex") executable = "codex";
  else if (command === "exec") executable = commandArgs.shift();
  if (!executable) throw new Error("Usage: agentx exec [options] -- <command>");
  const client: "anthropic" | "openai" = command === "exec"
    ? (opts["client-protocol"] === "openai" ? "openai" : "anthropic")
    : executable === "codex" ? "openai" : "anthropic";
  return { executable, client, commandArgs };
}

/**
 * Shared launch path for `claude`/`codex`/`proxy`/`exec`: runtime
 * resolution (interactive or not), native-launch bypass, credential
 * resolution with a missing-key recovery flow, adapter startup, and finally
 * handing off to {@link launchClient}. `deps` only affects the final
 * `launchClient` call, so tests can exercise the install-recovery flow.
 */
export async function runClientLaunch(command: string, args: string[], deps: ClientLaunchDeps = {}): Promise<void> {
  const opts = options(args);
  // --base-url defines (and persists) a custom provider ad hoc, without going
  // through the TUI's "Add custom provider…" flow — the non-interactive path
  // for exec/scripts/CI, but not restricted to exec: it works the same way
  // for claude/codex. --provider doubles as the display name here.
  if (opts["base-url"]) {
    const protocol: ProviderProtocol = opts.protocol === "responses" || opts.protocol === "anthropic" ? opts.protocol : "chat-completions";
    const definition = registerCustomProvider({ name: opts.provider ?? "custom", baseUrl: opts["base-url"], protocol, model: opts.model });
    await saveCustomProvider(definition.id, { name: definition.name, baseUrl: opts["base-url"], protocol, model: definition.models[0].model });
    opts.provider = definition.id;
  }
  // Native launch is only meaningful for claude/codex: they have their own
  // login/billing outside AgentX. It can come from an explicit `--native`
  // flag (checked here, before any catalog/adapter work) or from the
  // interactive quick-start menu (detected via `runtime.native` below).
  const nativeCapable = command === "claude" || command === "codex";
  let nativeRequested = nativeCapable && isNativeRequested(opts);
  if (CLIENT_COMMANDS.has(command) && !nativeRequested) {
    // The launcher needs the OpenCode catalog when the provider is not yet known.
    await refreshProviderCatalog({ provider: opts.provider ?? process.env.AGENTX_PROVIDER });
    const runtime = await resolveClientRuntime(command, opts);
    if (runtime.native) {
      nativeRequested = true;
    } else {
      opts.provider = runtime.provider;
      opts.model = runtime.model;
      if (runtime.apiKey) opts.apiKey = runtime.apiKey;
      await saveLastModel(runtime.provider, runtime.model);
    }
  } else if (command === "proxy" || command === "exec") {
    const lastSelection = await loadLastSelection();
    await refreshProviderCatalog({ provider: opts.provider ?? process.env.AGENTX_PROVIDER ?? lastSelection?.provider });
  }

  if (nativeRequested) {
    // Bypass AgentX entirely: no catalog, credential, config, or adapter
    // involvement, and the client's environment is left as inherited (no
    // ANTHROPIC_*/OPENAI_* overrides), so it behaves as if launched by hand.
    // nativeClientEnvironment additionally scrubs AgentX's own variables when
    // this process is itself nested inside a client AgentX already launched
    // (e.g. `agentx claude --native` typed inside an agentx-started Claude
    // Code session) — see its doc comment in process.ts.
    const separator = args.indexOf("--");
    const commandArgs = separator >= 0 ? args.slice(separator + 1) : clientArguments(args);
    console.error(`AgentX\n✓ Client: ${CLIENT_LABELS[command]} (native — adapter skipped)`);
    process.exitCode = await launchClient(command, commandArgs, nativeClientEnvironment(process.env), deps);
    return;
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
  const clientLabel = command === "codex" ? "Codex" : command === "claude" ? "Claude Code" : "command";
  console.error(`AgentX\n✓ Client: ${clientLabel}\n✓ Provider: ${config.provider ?? "opencode"}\n✓ Adapter started on ${config.host}:${adapter.port}\n✓ Model: ${config.model}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") console.error("Warning: Adapter will be accessible from the network.");

  if (command === "proxy") {
    const base = `http://${config.host}:${adapter.port}`;
    console.error(`\nEndpoints:\n  Anthropic Messages:       ${base}/v1/messages\n  OpenAI Responses:         ${base}/v1/responses\n  OpenAI Chat Completions:  ${base}/v1/chat/completions\n`);
    console.error("Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const close = async () => { await adapter.close(); resolve(); };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
    return;
  }

  const { executable, client, commandArgs } = resolveLaunchTarget(command, args, opts);
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
    process.exitCode = await launchClient(executable, launchArgs, clientEnvironment(config, adapter, client), deps);
  } finally {
    await adapter.close();
  }
}

/**
 * Re-register every custom provider persisted in runtime.json into the
 * in-memory registry. `registerCustomProvider` is idempotent by id, so this
 * is safe to call once at the top of every invocation — a fresh process
 * otherwise has no memory of custom providers added in a previous run.
 */
async function hydrateCustomProviders(): Promise<void> {
  const saved = await loadCustomProviders();
  for (const [, definition] of Object.entries(saved)) {
    registerCustomProvider({ name: definition.name, baseUrl: definition.baseUrl, protocol: definition.protocol as ProviderProtocol, model: definition.model });
  }
}

async function main() {
  await hydrateCustomProviders();
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "version") return console.log(versionText());
  if (command === "help" || command === "--help" || command === "-h") return console.log(helpText(args[0]));
  if (command === "auth") return runAuthCommand(args);
  if (command === "usage") return runUsageCommand(args);
  if (command === "quota") return runQuotaCliCommand(args);
  if (command === "doctor") return runDoctorCommand(args);
  if (command === "forget") return runForgetCommand(args);
  return runClientLaunch(command, args);
}

// Only run when executed directly (`node dist/src/cli.js ...`, i.e. the real
// CLI entry point) — not when this module is imported, e.g. by tests that
// exercise the exported command handlers directly with their own arguments.
// process.argv[1] must be realpath-resolved before comparing: a global
// install's bin entry is a symlink (e.g. .../bin/agentx ->
// .../lib/node_modules/@tzzs/agentx/dist/src/cli.js), so argv[1] is the
// symlink path while import.meta.url is already the resolved target —
// comparing them raw silently never matches, and main() never runs.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    if (error instanceof LaunchCancelledError) { process.exitCode = error.exitCode; return; }
    const message = error instanceof Error ? error.message : error;
    console.error(message);
    process.exitCode = 1;
  });
}
