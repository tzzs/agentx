import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { __resetTestIO, __setTestIO, providerEntries, runInteractiveLauncher, selectProvider, type ProviderEntry } from "../src/ui.js";
import { defaultModelFor } from "../src/selection.js";
import { providerById, providerRegistry, registerCustomProvider, unregisterCustomProvider } from "../src/providers/registry.js";
import { loadCustomProviders, loadLastQuickAction, saveCustomProvider, saveDefaultRuntime, saveLastQuickAction } from "../src/runtime.js";

test("lists all configured providers from the registry", async () => {
  const entries = await providerEntries();
  assert.ok(entries.length >= 3);
  const ids = entries.map((entry) => entry.definition.id);
  assert.ok(ids.includes("opencode"));
  assert.ok(ids.includes("deepseek"));
  assert.ok(ids.includes("openrouter"));
});

test("reports configured status per provider", async () => {
  const entries = await providerEntries();
  const deepseek = entries.find((entry) => entry.definition.id === "deepseek");
  assert.ok(deepseek);
  assert.equal(deepseek.configured, Boolean(process.env.DEEPSEEK_API_KEY));
});

test("falls back to a deterministic default model in non-interactive mode", () => {
  const model = defaultModelFor("opencode");
  assert.equal(model, "gpt-5.6-luna");
});

test("launcher passes through unchanged in non-interactive mode", async () => {
  const initial = { provider: "deepseek", model: "deepseek-v4-pro", source: "default" as const, defaultApplied: true };
  const outcome = await runInteractiveLauncher("claude", initial);
  assert.equal(outcome.provider, "deepseek");
  assert.equal(outcome.model, "deepseek-v4-pro");
  assert.equal(outcome.defaultApplied, true);
  assert.equal(outcome.changed, false);
  assert.equal(outcome.madeDefault, false);
});

// --- Interactive TUI tests: drive real clack prompts through a fake TTY ---
//
// @clack/prompts forwards its `input`/`output` options straight to
// @clack/core's Prompt, which drives everything through node:readline's
// keypress-event pipeline — it never hardcodes process.stdin/stdout. ui.ts's
// __setTestIO/__resetTestIO point every prompt this module renders at the
// streams below instead, so real key sequences (not synthetic keypress
// objects) drive the actual prompt exactly as a typed key would.

interface FakeTTY {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  readonly text: string;
  type(value: string): Promise<void>;
  pressEnter(): Promise<void>;
  pressDown(): Promise<void>;
  pressUp(): Promise<void>;
  pressCtrlC(): Promise<void>;
}

function createFakeTTY(): FakeTTY {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => input });
  const output = new PassThrough();
  Object.assign(output, { isTTY: true, columns: 80 });
  let text = "";
  output.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  // A short real delay, not just a microtask tick: writing a byte has to
  // flow through the PassThrough's 'data' event, readline's keypress
  // parser, and clack's own render before the prompt's state reflects it.
  const tick = (ms = 15) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const send = async (data: string) => { input.write(data); await tick(); };
  return {
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    get text() { return text; },
    async type(value: string) { for (const ch of value) await send(ch); },
    pressEnter: () => send("\r"),
    pressDown: () => send("\x1B[B"),
    pressUp: () => send("\x1B[A"),
    pressCtrlC: () => send("\x03"),
  };
}

let configDir: string;
test.before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-ui-"));
  process.env.XDG_CONFIG_HOME = configDir;
});
test.after(async () => {
  delete process.env.XDG_CONFIG_HOME;
  await rm(configDir, { recursive: true, force: true });
});
test.afterEach(() => { __resetTestIO(); });

/** entries with exactly one built-in provider, so the picker's first screen is short and predictable: [provider, "Add custom provider…"]. */
function soloEntries(): ProviderEntry[] {
  return [{ definition: providerById("opencode"), configured: true, modelCount: providerById("opencode").models.length }];
}

test("Add custom provider: registers it, persists connection metadata only, and returns its id", async () => {
  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const resultPromise = selectProvider(soloEntries(), "opencode");

  await tty.pressDown(); // -> "Add custom provider…" (the only other option)
  await tty.pressEnter();
  await tty.type("My Local LLM");
  await tty.pressEnter(); // name
  await tty.type("http://localhost:11434");
  await tty.pressEnter(); // base URL
  await tty.pressDown(); // Chat Completions -> Responses
  await tty.pressDown(); // Responses -> Anthropic Messages API
  await tty.pressEnter(); // protocol = anthropic
  // Back at the (refreshed) provider picker, the new provider is the initialValue; accept it.
  await tty.pressEnter();

  const result = await resultPromise;
  try {
    assert.equal(result, "my-local-llm");
    assert.equal(providerById("my-local-llm").custom, true);
    assert.equal(providerById("my-local-llm").models[0].protocol, "anthropic");
    assert.equal(providerById("my-local-llm").models[0].endpoint, "http://localhost:11434/v1/messages");
    const persisted = await loadCustomProviders();
    assert.deepEqual(persisted["my-local-llm"], { name: "My Local LLM", baseUrl: "http://localhost:11434", protocol: "anthropic", model: "custom-model" });
    // Never anything key-shaped in the persisted record.
    assert.equal(JSON.stringify(persisted["my-local-llm"]).toLowerCase().includes("key"), false);
  } finally {
    unregisterCustomProvider("my-local-llm");
  }
});

test("Add custom provider: cancelling at the name prompt registers nothing and returns to the original selection", async () => {
  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const before = providerRegistry.length;
  const resultPromise = selectProvider(soloEntries(), "opencode");

  await tty.pressDown(); // -> "Add custom provider…"
  await tty.pressEnter();
  await tty.pressCtrlC(); // cancel at the name prompt
  // The picker reopens with the original "current" (opencode) as initialValue.
  await tty.pressEnter();

  const result = await resultPromise;
  assert.equal(result, "opencode");
  assert.equal(providerRegistry.length, before);
});

test("Remove custom provider: only offered once a custom provider exists, and removing it clears both the registry and persisted state", async () => {
  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });

  // First screen with no custom providers: the option must not even render.
  const noneYet = await providerEntries();
  const firstScreen = selectProvider(noneYet, "opencode");
  await tty.pressEnter(); // accept "opencode" itself, just to observe the render and move on
  await firstScreen;
  assert.equal(tty.text.includes("Remove custom provider"), false);

  // Register one directly (bypassing the Add flow, which is already covered above).
  const definition = registerCustomProvider({ name: "Removable", baseUrl: "http://x", protocol: "chat-completions" });
  await saveCustomProvider(definition.id, { name: definition.name, baseUrl: "http://x", protocol: "chat-completions", model: definition.models[0].model });

  try {
    const entriesWithCustom: ProviderEntry[] = [...soloEntries(), { definition, configured: false, modelCount: 1 }];
    const resultPromise = selectProvider(entriesWithCustom, "opencode");
    // Controlled list: opencode, removable, "Add custom provider…", "Remove custom provider…"
    // — three steps down from opencode (the initialValue) reaches Remove.
    await tty.pressDown();
    await tty.pressDown();
    await tty.pressDown();
    await tty.pressEnter(); // -> "Remove custom provider…"
    await tty.pressEnter(); // the only entry in that sub-list is "Removable"; accept it
    // Back at the refreshed provider picker; accept whatever is highlighted.
    await tty.pressEnter();
    await resultPromise;

    assert.ok(!providerRegistry.some((entry) => entry.id === definition.id));
    assert.equal((await loadCustomProviders())[definition.id], undefined);
  } finally {
    unregisterCustomProvider(definition.id);
  }
});

test("quick-start menu remembers the last picked action ('native') as the next launch's default", async () => {
  await saveDefaultRuntime("claude", { provider: "deepseek", model: "deepseek-v4-pro" });
  await saveLastQuickAction("claude", "native");

  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const initial = { provider: "deepseek", model: "deepseek-v4-pro", source: "default" as const, defaultApplied: true };
  const resultPromise = runInteractiveLauncher("claude", initial);

  // "native" is the remembered initialValue, so accepting immediately picks it.
  await tty.pressEnter();

  const outcome = await resultPromise;
  assert.equal(outcome.native, true);
  assert.equal(outcome.provider, "deepseek");
  assert.equal(outcome.model, "deepseek-v4-pro");
  // The choice re-persists (a no-op here, but exercises the save path).
  assert.equal(await loadLastQuickAction("claude"), "native");
});

test("quick-start menu falls back to 'start' when the remembered action no longer applies (client lost native capability)", async () => {
  await saveDefaultRuntime("pi", { provider: "opencode", model: "gpt-5.6-luna" });
  await saveLastQuickAction("pi", "native"); // "pi" is not in NATIVE_CAPABLE_CLIENTS

  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const initial = { provider: "opencode", model: "gpt-5.6-luna", source: "default" as const, defaultApplied: true };
  const resultPromise = runInteractiveLauncher("pi", initial);

  await tty.pressEnter(); // accepts "start", the only sane initialValue for a non-native-capable client

  const outcome = await resultPromise;
  assert.equal(outcome.native, undefined);
  assert.equal(outcome.provider, "opencode");
  assert.equal(outcome.model, "gpt-5.6-luna");
  assert.equal(await loadLastQuickAction("pi"), "start");
});
