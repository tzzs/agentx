import { emitKeypressEvents } from "node:readline";
import { providers, type ModelProvider } from "./catalog.js";

export function selectableProviders(client: "claude" | "codex"): ModelProvider[] {
  return client === "codex" ? providersForResponses() : providers;
}

function providersForResponses() {
  return providers;
}

export async function selectModel(client: "claude" | "codex", choices: ModelProvider[]): Promise<string> {
  if (!choices.length) throw new Error("No OpenCode models are configured.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) return choices[0].model;
  let selected = 0;
  const render = () => {
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`Select OpenCode model for ${client === "claude" ? "Claude Code" : "Codex"}\n\n`);
    choices.forEach((choice, index) => process.stdout.write(`${index === selected ? "❯" : " "} ${choice.model} (${choice.protocol})\n`));
    process.stdout.write("\nUse ↑/↓ to select, Enter to confirm, Ctrl+C to cancel.\n");
  };
  return new Promise((resolve, reject) => {
    const onKeypress = (_: string, key: { name?: string; ctrl?: boolean; }) => {
      if (key.ctrl && key.name === "c") { cleanup(); reject(new Error("Model selection cancelled.")); return; }
      if (key.name === "up") selected = (selected + choices.length - 1) % choices.length;
      if (key.name === "down") selected = (selected + 1) % choices.length;
      if (key.name === "return" || key.name === "enter") { const model = choices[selected].model; cleanup(); process.stdout.write("\x1b[2J\x1b[H"); resolve(model); return; }
      render();
    };
    emitKeypressEvents(process.stdin);
    const cleanup = () => { process.stdin.off("keypress", onKeypress); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdin.pause(); };
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("keypress", onKeypress); render();
  });
}
