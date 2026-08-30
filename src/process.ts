import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Adapter } from "./server.js";
import type { Config } from "./config.js";
import { isDeepSeekLongContextModel, providerFor } from "./providers/registry.js";

/**
 * Model for Claude Code's background/haiku tier (permission checks, topic
 * detection, summarization). Defaults to the selected model so user choice
 * is always respected; only an explicit `--background-model` / env override
 * routes this lane elsewhere. An unresolvable override falls back to the
 * main model rather than breaking startup.
 */
export function backgroundModel(config: Config): string {
  const override = config.backgroundModel?.trim();
  if (!override || override === config.model) return config.model;
  try {
    providerFor(override, config.provider);
    return override;
  } catch { return config.model; }
}

/** Claude Code does not know custom DeepSeek ids, so declare their real window. */
function claudeContextEnvironment(config: Config, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const models = [config.model, backgroundModel(config)];
  if (!models.some(isDeepSeekLongContextModel)) return {};
  return {
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: inherited.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? "1000000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: inherited.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "786432",
  };
}

/**
 * Set on every environment AgentX constructs for a launched client — the only
 * variable whose sole purpose is marking "AgentX built this environment", as
 * opposed to `AGENTX_MODEL` etc. which users also set by hand as automation
 * input. Lets `nativeClientEnvironment` tell an ancestor AgentX launch apart
 * from a genuinely hand-configured environment.
 */
const AGENTX_ACTIVE = "AGENTX_ACTIVE";

/**
 * AgentX's own configuration variables. These are never injected by
 * clientEnvironment (users set them by hand as automation input), but they are
 * still AgentX-managed state a nested `--native` launch must not inherit —
 * otherwise the "native" client re-runs the outer launch's provider/model
 * selection instead of the user's own environment.
 */
const AGENTX_INPUT_ENV_KEYS = [
  "AGENTX_PROVIDER",
  "AGENTX_HOST",
  "AGENTX_PORT",
  "AGENTX_RETRY",
  "AGENTX_BACKGROUND_MODEL",
  "AGENTX_LOG_LEVEL",
];

/** Every variable AgentX itself ever injects into a launched client, across both protocols. */
const AGENTX_MANAGED_ENV_KEYS = [
  AGENTX_ACTIVE,
  "AGENTX_MODEL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  ...AGENTX_INPUT_ENV_KEYS,
];

export function clientEnvironment(config: Config, adapter: Adapter, client: "anthropic" | "openai"): NodeJS.ProcessEnv {
  const baseUrl = `http://${config.host}:${adapter.port}`;
  const inherited = { ...process.env };
  delete inherited.ANTHROPIC_API_KEY;
  delete inherited.ANTHROPIC_AUTH_TOKEN;
  const auxModel = client === "anthropic" ? backgroundModel(config) : config.model;
  return client === "openai"
    ? { ...inherited, [AGENTX_ACTIVE]: "1", OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_API_KEY: adapter.token, OPENAI_MODEL: config.model }
    : { ...inherited, ...claudeContextEnvironment(config, inherited), [AGENTX_ACTIVE]: "1", AGENTX_MODEL: config.model, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: adapter.token, ANTHROPIC_MODEL: config.model, ANTHROPIC_DEFAULT_OPUS_MODEL: config.model, ANTHROPIC_DEFAULT_SONNET_MODEL: config.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: auxModel, ANTHROPIC_SMALL_FAST_MODEL: auxModel, CLAUDE_CODE_SUBAGENT_MODEL: config.model };
}

/**
 * Environment for a `--native` launch. Normally the inherited environment is
 * handed through untouched, matching "runs exactly as if you had invoked it
 * yourself". But `--native` can itself run nested inside a client AgentX
 * already launched (e.g. `agentx claude --native` typed inside a Claude Code
 * session that `agentx claude` started) — in that case the inherited
 * environment still carries AgentX's own ANTHROPIC_ and OPENAI_ overrides from
 * the outer launch, which would silently point the "native" client right
 * back at the adapter it's supposed to bypass. `AGENTX_ACTIVE` marks exactly
 * that case, so it's scrubbed only when actually present — a hand-configured
 * environment that never went through AgentX is left completely alone.
 */
export function nativeClientEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!env[AGENTX_ACTIVE]) return env;
  const cleaned = { ...env };
  for (const key of AGENTX_MANAGED_ENV_KEYS) delete cleaned[key];
  return cleaned;
}

/**
 * Codex stopped honoring `OPENAI_BASE_URL`/`OPENAI_API_KEY` environment
 * variables and gates startup on a stored login (`~/.codex/auth.json`), which
 * surfaced its sign-in screen on every launch. These `-c` overrides define an
 * inline custom provider instead: requests go to the local adapter and the
 * bearer token is read from the injected `OPENAI_API_KEY`, so no OpenAI login
 * state is ever consulted. Values use TOML literal strings (single quotes) so
 * they survive Windows shell re-parsing.
 */
export function codexLaunchArgs(config: Config, adapter: Adapter, catalogPath?: string): string[] {
  return [
    "-c", "model_provider='agentx'",
    "-c", "model_providers.agentx.name='AgentX'",
    "-c", `model_providers.agentx.base_url='http://${config.host}:${adapter.port}/v1'`,
    "-c", "model_providers.agentx.wire_api='responses'",
    "-c", "model_providers.agentx.env_key='OPENAI_API_KEY'",
    ...(catalogPath ? ["-c", `model_catalog_json='${catalogPath}'`] : []),
    "-m", config.model,
  ];
}

/** Shell-conventional exit codes for signal terminations (128 + signal number). */
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/**
 * Thrown when the client executable itself cannot be spawned — most commonly
 * because it is not installed or not on PATH (`spawn x ENOENT`). Carries the
 * executable name so callers can offer an actionable recovery flow.
 */
export class ClientNotFoundError extends Error {
  constructor(readonly executable: string) {
    super(`Client "${executable}" was not found: it is not installed or not on PATH.`);
    this.name = "ClientNotFoundError";
  }
}

/** Recommended global-install command per known client executable. */
export const CLIENT_INSTALL_COMMANDS: Record<string, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  pi: "npm install -g @mariozechner/pi",
};

/** Run a command through the user's shell with inherited stdio; resolves with the exit code.
 * Spawn failures (e.g. no shell) resolve to 1 instead of rejecting, so the caller's
 * install-recovery branch stays in charge of reporting. */
export function runShellCommand(command: string): Promise<number> {
  const child = spawn(command, { stdio: "inherit", shell: true });
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Windows-only: runCommand spawns with shell:true so npm's .cmd shims resolve
 * (plain spawn() without a shell can't find them by extension-less name), but
 * that means a missing command never reaches spawn()'s own ENOENT handling —
 * cmd.exe itself launches fine, then exits with a plain non-zero code after
 * printing "not recognized" to stderr. Resolve PATH/PATHEXT ourselves first,
 * the same way cmd.exe would, so a missing client still surfaces as
 * ClientNotFoundError instead of being indistinguishable from the real client
 * having run and failed.
 */
async function isMissingOnWindowsPath(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try { await access(join(dir, command + ext)); return false; } catch { /* keep looking */ }
    }
  }
  return true;
}

/** Spawns `command` with `env` verbatim — the caller decides whether that is
 * the adapter-injected environment or an untouched passthrough (native mode). */
export async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (process.platform === "win32" && (await isMissingOnWindowsPath(command, env))) {
    throw new ClientNotFoundError(command);
  }
  const child = spawn(command, args, { stdio: "inherit", env, shell: process.platform === "win32" });
  // The child shares the terminal process group (stdio: "inherit", not detached),
  // so a terminal Ctrl+C / SIGINT already reaches both the child and this process.
  // Forwarding SIGINT would deliver a second signal to the child, which it may
  // treat as a forced abort mid-task. Only SIGTERM (typically targeted at this
  // process alone, e.g. `kill <pid>`) is forwarded.
  const forwardSigterm = () => child.kill("SIGTERM");
  const stayAlive = () => {};
  process.once("SIGTERM", forwardSigterm);
  process.on("SIGINT", stayAlive);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new ClientNotFoundError(command) : error));
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 128) : 1)));
    });
  }
  finally { process.removeListener("SIGTERM", forwardSigterm); process.removeListener("SIGINT", stayAlive); }
}
