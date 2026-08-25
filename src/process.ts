import { spawn } from "node:child_process";
import type { Adapter } from "./server.js";
import type { Config } from "./config.js";
import { providerFor } from "./providers/registry.js";

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

export function clientEnvironment(config: Config, adapter: Adapter, client: "anthropic" | "openai"): NodeJS.ProcessEnv {
  const baseUrl = `http://${config.host}:${adapter.port}`;
  const inherited = { ...process.env };
  delete inherited.ANTHROPIC_API_KEY;
  delete inherited.ANTHROPIC_AUTH_TOKEN;
  const auxModel = client === "anthropic" ? backgroundModel(config) : config.model;
  return client === "openai"
    ? { ...inherited, OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_API_KEY: adapter.token, OPENAI_MODEL: config.model }
    : { ...inherited, AGENTX_MODEL: config.model, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: adapter.token, ANTHROPIC_MODEL: config.model, ANTHROPIC_DEFAULT_OPUS_MODEL: config.model, ANTHROPIC_DEFAULT_SONNET_MODEL: config.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: auxModel, ANTHROPIC_SMALL_FAST_MODEL: auxModel, CLAUDE_CODE_SUBAGENT_MODEL: config.model };
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
    ...(config.model === "auto" ? [] : ["-m", config.model]),
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

/** Run a command through the user's shell with inherited stdio; resolves with the exit code. */
export function runShellCommand(command: string): Promise<number> {
  const child = spawn(command, { stdio: "inherit", shell: true });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

export async function runCommand(command: string, args: string[], config: Config, adapter: Adapter, client: "anthropic" | "openai" = "anthropic"): Promise<number> {
  const child = spawn(command, args, { stdio: "inherit", env: clientEnvironment(config, adapter, client), shell: process.platform === "win32" });
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
