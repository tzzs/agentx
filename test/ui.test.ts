import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { __resetTestIO, __setTestIO, providerEntries, runInteractiveLauncher, runProviderManager, runSavedModelManager, selectProvider, type ProviderEntry } from "../src/ui.js";
import { defaultModelFor } from "../src/selection.js";
import { resetProfileCredentials } from "../src/credentials.js";
import { providerById, providerRegistry, registerCustomProvider, unregisterCustomProvider } from "../src/providers/registry.js";
import { loadCustomProviders, loadDefaultRuntime, loadLastQuickAction, saveCustomProvider, saveDefaultRuntime, saveLastModel, saveLastQuickAction } from "../src/runtime.js";

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
  await tty.pressEnter(); // protocol = Anthropic Messages (default, first)
  await tty.type("http://localhost:11434");
  await tty.pressEnter(); // base URL
  await tty.type("My Local LLM");
  await tty.pressEnter(); // name — returns straight to the caller, no extra picker screen

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

test("Add custom provider: the single Protocol screen maps each choice to the upstream protocol and endpoint", async () => {
  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const resultPromise = selectProvider(soloEntries(), "opencode");

  await tty.pressDown(); // -> "Add custom provider…"
  await tty.pressEnter();
  await tty.pressDown(); // Anthropic Messages -> OpenAI Responses
  await tty.pressEnter(); // protocol = responses
  await tty.type("https://api.openai.com/v1");
  await tty.pressEnter(); // base URL
  await tty.type("OpenAI Responses");
  await tty.pressEnter(); // name

  const result = await resultPromise;
  try {
    assert.equal(result, "openai-responses");
    assert.equal(providerById("openai-responses").models[0].protocol, "responses");
    assert.equal(providerById("openai-responses").models[0].endpoint, "https://api.openai.com/v1/responses");
  } finally {
    unregisterCustomProvider("openai-responses");
  }
});

test("Add custom provider: cancelling at the name prompt registers nothing and returns to the original selection", async () => {
  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const before = providerRegistry.length;
  const resultPromise = selectProvider(soloEntries(), "opencode");

  await tty.pressDown(); // -> "Add custom provider…"
  await tty.pressEnter();
  await tty.pressDown(); // Anthropic Messages -> OpenAI Responses
  await tty.pressDown(); // OpenAI Responses -> OpenAI Chat Completions
  await tty.pressEnter(); // protocol = chat-completions
  await tty.type("http://localhost:11434");
  await tty.pressEnter(); // base URL
  await tty.pressCtrlC(); // cancel at the name prompt
  // The picker reopens with the original "current" (opencode) as initialValue.
  await tty.pressEnter();

  const result = await resultPromise;
  assert.equal(result, "opencode");
  assert.equal(providerRegistry.length, before);
});

test("runProviderManager: adds a custom provider, prints its key guidance, and exits on cancel", async () => {
  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const manager = runProviderManager();

  // The Add sentinel sits right after every registry provider.
  for (let i = 0; i < providerRegistry.length; i++) await tty.pressDown();
  await tty.pressEnter(); // -> "Add custom provider…"
  await tty.pressDown(); // Anthropic Messages -> OpenAI Responses
  await tty.pressDown(); // OpenAI Responses -> OpenAI Chat Completions
  await tty.pressEnter(); // protocol = chat-completions
  await tty.type("http://localhost:11434");
  await tty.pressEnter(); // base URL
  await tty.type("Config Test LLM");
  await tty.pressEnter(); // name
  await tty.type("n"); // decline persisting the key to the shell profile
  await tty.pressCtrlC(); // leave the manager

  await manager;
  try {
    assert.equal(providerById("config-test-llm").models[0].protocol, "chat-completions");
    assert.equal(providerById("config-test-llm").models[0].endpoint, "http://localhost:11434/chat/completions");
    assert.ok((await loadCustomProviders())["config-test-llm"]);
    // No launch follows, so the manager must print how to persist the key.
    assert.match(tty.text, /AGENTX_CONFIG_TEST_LLM_API_KEY/);
  } finally {
    unregisterCustomProvider("config-test-llm");
  }
});

test("runProviderManager: an accepted key setup writes a marked export block to the shell profile", async () => {
  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const home = await mkdtemp(join(tmpdir(), "agentx-home-"));
  const savedEnv = { HOME: process.env.HOME, SHELL: process.env.SHELL, ZDOTDIR: process.env.ZDOTDIR };
  process.env.HOME = home;
  process.env.SHELL = "/bin/zsh";
  delete process.env.ZDOTDIR;
  const manager = runProviderManager();

  // The Add sentinel sits right after every registry provider.
  for (let i = 0; i < providerRegistry.length; i++) await tty.pressDown();
  await tty.pressEnter(); // -> "Add custom provider…"
  await tty.pressDown(); // Anthropic Messages -> OpenAI Responses
  await tty.pressDown(); // OpenAI Responses -> OpenAI Chat Completions
  await tty.pressEnter(); // protocol = chat-completions
  await tty.type("http://localhost:11434");
  await tty.pressEnter(); // base URL
  await tty.type("Profile Test LLM");
  await tty.pressEnter(); // name
  await tty.pressEnter(); // confirm writing the key to the shell profile (default yes)
  await tty.type("sk-profile-secret");
  await tty.pressEnter(); // API key
  await tty.pressCtrlC(); // leave the manager

  await manager;
  try {
    const profile = await readFile(join(home, ".zshrc"), "utf8");
    assert.match(profile, /# >>> agentx credentials: AGENTX_PROFILE_TEST_LLM_API_KEY >>>/);
    assert.match(profile, /export AGENTX_PROFILE_TEST_LLM_API_KEY='sk-profile-secret'/);
    // The key must be masked in the TUI and never echoed back.
    assert.doesNotMatch(tty.text, /sk-profile-secret/);
    // The manager's own view is hydrated from the profile right after writing.
    assert.equal((await providerEntries()).find((entry) => entry.definition.id === "profile-test-llm")?.configured, true);
  } finally {
    unregisterCustomProvider("profile-test-llm");
    resetProfileCredentials();
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  }
});

test("pre-selecting a configured provider resolves its own model and never offers OpenRouter's catalog", async () => {
  await withIsolatedRuntime({ AGENTX_DS_SWITCH_TEST_API_KEY: "test-key" }, async () => {
    const definition = registerCustomProvider({ name: "Ds Switch Test", baseUrl: "http://ds-switch.invalid", protocol: "chat-completions" });
    try {
      const tty = createFakeTTY();
      __setTestIO({ input: tty.input, output: tty.output });
      const initial = { provider: "opencode", model: defaultModelFor("opencode"), source: "builtin" as const, defaultApplied: false };
      const resultPromise = runInteractiveLauncher("codex", initial);

      await tty.pressEnter(); // top-level: "Select provider / model"
      // With no saved default the launcher pre-selects the configured provider,
      // so ds-switch-test (the only one) is already highlighted.
      await tty.pressEnter();
      await tty.type("deepseek-flash");
      await tty.pressEnter(); // model id completes the launcher

      const outcome = await resultPromise;
      assert.equal(outcome.provider, "ds-switch-test");
      assert.equal(outcome.model, "deepseek-flash");
      assert.deepEqual(await loadDefaultRuntime("codex"), { provider: "ds-switch-test", model: "deepseek-flash" });
      assert.match(tty.text, /Custom model id \(Ds Switch Test\)/, "a fresh custom endpoint asks for a real model id directly");
      assert.doesNotMatch(tty.text, /custom-model/, "the synthesized placeholder is not a real model id");
      assert.doesNotMatch(tty.text, /gpt-5.6-luna/, "the fallback provider's model must not be carried over as 'current'");
      assert.doesNotMatch(tty.text, /Browse OpenRouter catalog/, "catalog browsing is OpenRouter-only");
      assert.doesNotMatch(tty.text, /Forget a saved model/, "nothing is saved for this provider yet");
    } finally {
      unregisterCustomProvider(definition.id);
    }
  });
});

test("switching provider in the picker drops the previous provider's model instead of carrying it over", async () => {
  await withIsolatedRuntime({ AGENTX_DS_SWITCH_TEST_API_KEY: "test-key" }, async () => {
    const definition = registerCustomProvider({ name: "Ds Switch Test", baseUrl: "http://ds-switch.invalid", protocol: "chat-completions" });
    try {
      await saveDefaultRuntime("codex", { provider: "opencode", model: defaultModelFor("opencode") });
      const tty = createFakeTTY();
      __setTestIO({ input: tty.input, output: tty.output });
      const initial = { provider: "opencode", model: defaultModelFor("opencode"), source: "default" as const, defaultApplied: true };
      const resultPromise = runInteractiveLauncher("codex", initial);
      const rejection = assert.rejects(resultPromise, { name: "LaunchCancelledError" });

      await tty.pressDown(); // Start -> Launch native
      await tty.pressDown(); // -> Change provider / model
      await tty.pressEnter();
      // Provider picker: ds-switch-test (configured) first, opencode (current) second.
      await tty.pressUp(); // -> ds-switch-test
      await tty.pressEnter();
      await tty.pressCtrlC(); // cancel at the model picker

      await rejection;
      assert.match(tty.text, /Custom model id \(Ds Switch Test\)/);
      assert.doesNotMatch(tty.text, /· current/, "the old provider's model must not be carried over");
    } finally {
      unregisterCustomProvider(definition.id);
    }
  });
});

test("a custom provider with a saved model shows the picker instead of the placeholder", async () => {
  await withIsolatedRuntime({ AGENTX_DS_SWITCH_TEST_API_KEY: "test-key" }, async () => {
    const definition = registerCustomProvider({ name: "Ds Switch Test", baseUrl: "http://ds-switch.invalid", protocol: "chat-completions" });
    try {
      await saveLastModel("ds-switch-test", "deepseek-chat");
      const tty = createFakeTTY();
      __setTestIO({ input: tty.input, output: tty.output });
      const initial = { provider: "opencode", model: defaultModelFor("opencode"), source: "builtin" as const, defaultApplied: false };
      const resultPromise = runInteractiveLauncher("codex", initial);
      const rejection = assert.rejects(resultPromise, { name: "LaunchCancelledError" });

      await tty.pressEnter(); // top-level: "Select provider / model"
      await tty.pressEnter(); // provider: ds-switch-test (pre-selected, configured)
      await tty.pressCtrlC(); // cancel at the model picker

      await rejection;
      assert.match(tty.text, /deepseek-chat · current/);
      assert.match(tty.text, /Search \/ enter any model id…/);
      assert.doesNotMatch(tty.text, /custom-model/);
    } finally {
      unregisterCustomProvider(definition.id);
    }
  });
});

test("OpenRouter's model picker still offers the live catalog browse", async () => {
  await withIsolatedRuntime({ AGENTX_OPENROUTER_API_KEY: "test-key" }, async () => {
    const tty = createFakeTTY();
    __setTestIO({ input: tty.input, output: tty.output });
    const initial = { provider: "opencode", model: defaultModelFor("opencode"), source: "builtin" as const, defaultApplied: false };
    const resultPromise = runInteractiveLauncher("codex", initial);
    const rejection = assert.rejects(resultPromise, { name: "LaunchCancelledError" });

    await tty.pressEnter(); // top-level: "Select provider / model"
    // With no saved default the launcher pre-selects the configured provider,
    // so openrouter (the only one) is already highlighted.
    await tty.pressEnter();
    await tty.pressCtrlC(); // cancel at the model picker

    await rejection;
    assert.match(tty.text, /Browse OpenRouter catalog/);
  });
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

test("saved-model manager offers non-OpenRouter ids without staleness hints", async () => {
  await saveLastModel("deepseek", "deepseek-v4-pro");
  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const manager = runSavedModelManager("deepseek");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await tty.pressEnter(); // submit the multiselect with nothing picked
  await manager;
  assert.match(tty.text, /deepseek-v4-pro/);
  // The OpenRouter catalog cannot judge a DeepSeek bare id — no stale hint.
  assert.doesNotMatch(tty.text, /no longer listed/);
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
  await saveDefaultRuntime("other-client", { provider: "opencode", model: "gpt-5.6-luna" });
  await saveLastQuickAction("other-client", "native"); // "other-client" is not in NATIVE_CAPABLE_CLIENTS

  const tty = createFakeTTY();
  __setTestIO({ input: tty.input, output: tty.output });
  const initial = { provider: "opencode", model: "gpt-5.6-luna", source: "default" as const, defaultApplied: true };
  const resultPromise = runInteractiveLauncher("other-client", initial);

  await tty.pressEnter(); // accepts "start", the only sane initialValue for a non-native-capable client

  const outcome = await resultPromise;
  assert.equal(outcome.native, undefined);
  assert.equal(outcome.provider, "opencode");
  assert.equal(outcome.model, "gpt-5.6-luna");
  assert.equal(await loadLastQuickAction("other-client"), "start");
});

// --- Top-level menu: shape driven by (any provider configured?, this client used before?) ---
//
// Provider-configured status comes straight from process.env (storedCredential
// reads AGENTX_<KEY> / <KEY>); this dev shell has real opencode/openrouter
// credentials exported, so these tests scope both the credential env vars and
// XDG_CONFIG_HOME to themselves and restore everything in `finally`.

const CREDENTIAL_ENV_VARS = ["AGENTX_OPENCODE_API_KEY", "OPENCODE_GO_API_KEY", "AGENTX_OPENROUTER_API_KEY", "OPENROUTER_API_KEY", "AGENTX_DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY"];

/** Runs `fn` with every known provider credential env var cleared (optionally re-adding a few), plus a fresh, isolated runtime.json. Restores both afterward. */
async function withIsolatedRuntime<T>(envOverrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const savedEnv = new Map(CREDENTIAL_ENV_VARS.map((key) => [key, process.env[key]]));
  const savedConfigDir = process.env.XDG_CONFIG_HOME;
  const tmp = await mkdtemp(join(tmpdir(), "agentx-ui-toplevel-"));
  for (const key of CREDENTIAL_ENV_VARS) delete process.env[key];
  for (const [key, value] of Object.entries(envOverrides)) process.env[key] = value;
  process.env.XDG_CONFIG_HOME = tmp;
  try {
    return await fn();
  } finally {
    for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (savedConfigDir === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfigDir;
    await rm(tmp, { recursive: true, force: true });
  }
}

async function cancelAtTopLevelMenu(client: string, initial: { provider: string; model: string; source: "builtin" | "default"; defaultApplied: boolean }, tty: FakeTTY): Promise<string> {
  const resultPromise = runInteractiveLauncher(client, initial);
  // Attach the rejection expectation synchronously, before yielding to the
  // event loop below — otherwise the node:test runner sees an unhandled
  // rejection in the window between creating the promise and awaiting it.
  const rejection = assert.rejects(resultPromise, { name: "LaunchCancelledError" });
  await tty.pressCtrlC();
  await rejection;
  return tty.text;
}

test("top-level menu: no provider configured shows Configure a provider / Native / Cancel — no Start, no Forget", async () => {
  await withIsolatedRuntime({}, async () => {
    const tty = createFakeTTY();
    __setTestIO({ input: tty.input, output: tty.output });
    const initial = { provider: "opencode", model: defaultModelFor("opencode"), source: "builtin" as const, defaultApplied: false };
    const text = await cancelAtTopLevelMenu("claude", initial, tty);

    assert.match(text, /Configure a provider/);
    assert.match(text, /Launch native \(skip AgentX\)/);
    assert.ok(text.indexOf("Configure a provider") < text.indexOf("Launch native"), "the provider setup step leads, native is the escape hatch");
    assert.doesNotMatch(text, /\bStart\b/);
    assert.doesNotMatch(text, /Forget a saved model/);
    assert.doesNotMatch(text, /Select provider \/ model/);
    assert.doesNotMatch(text, /Change provider \/ model/);
  });
});

test("top-level menu: no provider configured, non-native-capable client shows only Configure a provider / Cancel", async () => {
  await withIsolatedRuntime({}, async () => {
    const tty = createFakeTTY();
    __setTestIO({ input: tty.input, output: tty.output });
    const initial = { provider: "opencode", model: defaultModelFor("opencode"), source: "builtin" as const, defaultApplied: false };
    const text = await cancelAtTopLevelMenu("proxy", initial, tty);

    assert.match(text, /Configure a provider/);
    assert.doesNotMatch(text, /Launch native/);
  });
});

test("top-level menu: provider configured but this client never launched shows Select provider / model / Native / Cancel — no Start", async () => {
  await withIsolatedRuntime({ AGENTX_DEEPSEEK_API_KEY: "test-key" }, async () => {
    const tty = createFakeTTY();
    __setTestIO({ input: tty.input, output: tty.output });
    const initial = { provider: "opencode", model: defaultModelFor("opencode"), source: "builtin" as const, defaultApplied: false };
    const text = await cancelAtTopLevelMenu("claude", initial, tty);

    assert.match(text, /Select provider \/ model/);
    assert.match(text, /Launch native \(skip AgentX\)/);
    assert.ok(text.indexOf("Select provider / model") < text.indexOf("Launch native"), "picking up the already-configured provider leads, native is the escape hatch");
    assert.doesNotMatch(text, /\bStart\b/);
    assert.doesNotMatch(text, /Configure a provider/);
  });
});

test("top-level menu: Forget only appears once something is actually saved, even for a client that never launched", async () => {
  await withIsolatedRuntime({ AGENTX_DEEPSEEK_API_KEY: "test-key" }, async () => {
    // Recorded via a different client (e.g. `codex`) or `proxy`/`exec`; "claude" itself still has no saved default.
    await saveLastModel("deepseek", "deepseek-v4-pro");

    const tty = createFakeTTY();
    __setTestIO({ input: tty.input, output: tty.output });
    const initial = { provider: "opencode", model: defaultModelFor("opencode"), source: "builtin" as const, defaultApplied: false };
    const text = await cancelAtTopLevelMenu("claude", initial, tty);

    assert.match(text, /Forget a saved model/);
  });
});
