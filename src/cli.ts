#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { startAdapter } from "./server.js";
import { runCommand } from "./process.js";
import { providers } from "./catalog.js";
import { selectableProviders, selectModel } from "./ui.js";

function options(args: string[]) { const out: Record<string, string | undefined> = {}; for (let i = 0; i < args.length; i++) { const key = args[i]; if (key?.startsWith("--")) out[key.slice(2)] = args[++i]; } return out; }
async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "version") return console.log("0.1.0");
  if (command === "help") return console.log("Usage: opencode-adapter <claude|codex|proxy|exec|doctor> [options]");
  if (command === "doctor") {
    const config = loadConfig(options(args)); const wsl = Boolean(process.env.WSL_INTEROP);
    console.log(`OpenCode Adapter Doctor\nNode.js        ${process.version}\nPlatform       ${wsl ? "WSL" : process.platform}\nArchitecture   ${process.arch}\nAPI key        ${config.apiKey ? "found" : "missing"}\nModels         ${providers.map((item) => item.model).join(", ")}\nClaude Code    ${await executableExists("claude") ? "found" : "not found"}\nCodex          ${await executableExists("codex") ? "found" : "not found"}`);
    if (!config.apiKey) { console.log("\nSet OPENCODE_GO_API_KEY before starting the adapter."); process.exitCode = 1; }
    return;
  }
  const opts = options(args);
  const clientCommand = command === "claude" || command === "codex" ? command : undefined;
  if (clientCommand && opts.model === undefined && !process.env.OPENCODE_ADAPTER_MODEL) opts.model = await selectModel(clientCommand, selectableProviders(clientCommand));
  const config = loadConfig(opts); const adapter = await startAdapter(config);
  console.error(`OpenCode Adapter\n✓ Client: ${command === "codex" ? "Codex" : command === "claude" ? "Claude Code" : "command"}\n✓ Adapter started on ${config.host}:${adapter.port}\n✓ OpenCode model: ${config.model}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost") console.error("Warning: Adapter will be accessible from the network.");
  if (command === "proxy") { console.error("Press Ctrl+C to stop."); await new Promise<void>((resolve) => { const close = async () => { await adapter.close(); resolve(); }; process.once("SIGINT", close); process.once("SIGTERM", close); }); return; }
  const separator = args.indexOf("--"); const adapterFlags = new Set(["--model", "--port", "--host", "--api-key", "--verbose"]); const commandArgs = separator >= 0 ? args.slice(separator + 1) : command === "claude" ? args.filter((arg, index) => !adapterFlags.has(arg) && !adapterFlags.has(args[index - 1] ?? "")) : [];
  const executable = command === "claude" ? "claude" : command === "codex" ? "codex" : command === "exec" ? commandArgs.shift() : undefined;
  if (!executable) throw new Error("Usage: opencode-adapter exec [options] -- <command>");
  const client = command === "codex" || executable === "codex" ? "openai" : "anthropic";
  const launchArgs = executable === "claude" && !commandArgs.includes("--bare") ? ["--bare", ...commandArgs] : commandArgs;
  try { process.exitCode = await runCommand(executable, launchArgs, config, adapter, client); } finally { await adapter.close(); }
}
async function executableExists(command: string) { try { const child = (await import("node:child_process")).spawn(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32" }); return await new Promise<boolean>((resolve) => { child.once("error", () => resolve(false)); child.once("exit", (code) => resolve(code === 0)); }); } catch { return false; } }
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
