import { spawn } from "node:child_process";
import type { Adapter } from "./server.js";
import type { Config } from "./config.js";

export function clientEnvironment(config: Config, adapter: Adapter, client: "anthropic" | "openai"): NodeJS.ProcessEnv {
  const baseUrl = `http://${config.host}:${adapter.port}`;
  const inherited = { ...process.env };
  delete inherited.ANTHROPIC_API_KEY;
  delete inherited.ANTHROPIC_AUTH_TOKEN;
  return client === "openai"
    ? { ...inherited, OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_API_KEY: adapter.token, OPENAI_MODEL: config.model }
    : { ...inherited, AGENTX_MODEL: config.model, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: adapter.token, ANTHROPIC_MODEL: config.model, ANTHROPIC_DEFAULT_OPUS_MODEL: config.model, ANTHROPIC_DEFAULT_SONNET_MODEL: config.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model, CLAUDE_CODE_SUBAGENT_MODEL: config.model };
}

/** Shell-conventional exit codes for signal terminations (128 + signal number). */
const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

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
  try { return await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 + (SIGNAL_NUMBERS[signal] ?? 128) : 1))); }); }
  finally { process.removeListener("SIGTERM", forwardSigterm); process.removeListener("SIGINT", stayAlive); }
}
