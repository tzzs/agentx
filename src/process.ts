import { spawn, type ChildProcess } from "node:child_process";
import type { Adapter } from "./server.js";
import type { Config } from "./config.js";

export async function runCommand(command: string, args: string[], config: Config, adapter: Adapter): Promise<number> {
  const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ANTHROPIC_BASE_URL: `http://${config.host}:${adapter.port}`, ANTHROPIC_API_KEY: adapter.token, ANTHROPIC_MODEL: config.model }, shell: process.platform === "win32" });
  const stop = (signal: NodeJS.Signals) => child.kill(signal);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { return await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1))); }); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
