#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startAdapter } from "./server.js";
import { runCommand } from "./process.js";

function options(args: string[]) { const out: Record<string, string | undefined> = {}; for (let i = 0; i < args.length; i++) { const key = args[i]; if (key?.startsWith("--")) out[key.slice(2)] = args[++i]; } return out; }
async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "version") return console.log("0.1.0");
  if (command === "help") return console.log("Usage: opencode-adapter <claude|proxy|exec|doctor> [options]");
  if (command === "doctor") { const config = loadConfig(); console.log(`Node.js ${process.version}\nPlatform ${process.platform}\nAPI key ${config.apiKey ? "found" : "missing"}\nModel ${config.model}`); return; }
  const opts = options(args); const config = loadConfig(opts); const adapter = await startAdapter(config);
  console.error(`OpenCode Adapter\n✓ Adapter started on ${config.host}:${adapter.port}\n✓ Model: ${config.model}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") console.error("Warning: Adapter will be accessible from the network.");
  if (command === "proxy") { console.error("Press Ctrl+C to stop."); await new Promise<void>((resolve) => { const close = async () => { await adapter.close(); resolve(); }; process.once("SIGINT", close); process.once("SIGTERM", close); }); return; }
  const separator = args.indexOf("--"); const commandArgs = separator >= 0 ? args.slice(separator + 1) : command === "claude" ? args.filter((arg) => !arg.startsWith("--")) : [];
  const executable = command === "claude" ? "claude" : command === "exec" ? commandArgs.shift() : undefined;
  if (!executable) throw new Error("Usage: opencode-adapter exec [options] -- <command>");
  try { process.exitCode = await runCommand(executable, commandArgs, config, adapter); } finally { await adapter.close(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
