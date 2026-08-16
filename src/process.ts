import { spawn } from "node:child_process";
import type { Adapter } from "./server.js";
import type { Config } from "./config.js";

export function clientEnvironment(config: Config, adapter: Adapter, client: "anthropic" | "openai"): NodeJS.ProcessEnv {
  const baseUrl = `http://${config.host}:${adapter.port}`;
  return client === "openai"
    ? { ...process.env, OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_API_KEY: adapter.token, OPENAI_MODEL: config.model }
    : { ...process.env, OPENCODE_ADAPTER_MODEL: config.model, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: adapter.token, ANTHROPIC_MODEL: "sonnet" };
}

export async function runCommand(command: string, args: string[], config: Config, adapter: Adapter, client: "anthropic" | "openai" = "anthropic"): Promise<number> {
  const child = spawn(command, args, { stdio: "inherit", env: clientEnvironment(config, adapter, client), shell: process.platform === "win32" });
  const stop = (signal: NodeJS.Signals) => child.kill(signal);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { return await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1))); }); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
