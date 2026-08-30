import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import {
  configureMissingProvider, launchClient, runAuthCommand, runClientLaunch, runDoctorCommand, runForgetCommand, runQuotaCliCommand, runUsageCommand, versionText,
} from "../src/cli.js";
import { ClientNotFoundError } from "../src/process.js";
import { providerById, providerRegistry, registerCustomProvider, unregisterCustomProvider } from "../src/providers/registry.js";
import { forgetRuntime, loadCustomProviders, saveLastModel, saveOpenRouterModels } from "../src/runtime.js";

// The compiled CLI's own module-scope entry-point guard (main() only runs
// when this file is the one actually executed, not merely imported) can only
// be exercised by really spawning the built dist/src/cli.js — every other
// test in this suite imports it, which by design never triggers that guard.
const CLI_ENTRY_POINT = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// dist/test/*.js sits two levels below the package root, same as dist/src.
const PACKAGE_VERSION = String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);

test("the built CLI entry point runs when invoked directly with node", () => {
  const result = spawnSync(process.execPath, [CLI_ENTRY_POINT, "version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), PACKAGE_VERSION);
});

test("regression: the built CLI entry point still runs when invoked through a symlink", async () => {
  // A global npm install's bin entry (e.g. .../bin/agentx) is a symlink to
  // this file; process.argv[1] is then the symlink path, not the resolved
  // target import.meta.url already reports, so the guard must realpath-resolve
  // argv[1] before comparing — a raw string comparison silently never matches
  // and main() never runs (the actual bug this test would have caught).
  const dir = await mkdtemp(join(tmpdir(), "agentx-entrypoint-"));
  const linkPath = join(dir, "agentx-cli-symlink.js");
  try {
    await symlink(CLI_ENTRY_POINT, linkPath);
    const result = spawnSync(process.execPath, [linkPath, "version"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), PACKAGE_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("versionText matches package.json instead of a hardcoded constant", () => {
  assert.equal(versionText(), PACKAGE_VERSION);
});

let configDir: string;
let logs: string[];
let errors: string[];
const originalLog = console.log;
const originalError = console.error;

test.before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-cli-commands-"));
  process.env.XDG_CONFIG_HOME = configDir;
});
test.after(async () => { delete process.env.XDG_CONFIG_HOME; await rm(configDir, { recursive: true, force: true }); });

test.beforeEach(() => {
  logs = []; errors = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  delete process.env.AGENTX_DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  process.exitCode = undefined;
});
test.afterEach(() => { console.log = originalLog; console.error = originalError; });

test("runAuthCommand login prints the derived AGENTX_ variable name", async () => {
  await runAuthCommand(["login", "--provider", "deepseek"]);
  assert.ok(logs.some((line) => line.includes("AGENTX_DEEPSEEK_API_KEY")));
});

test("runAuthCommand status reports missing then configured", async () => {
  await runAuthCommand(["status", "--provider", "deepseek"]);
  assert.ok(logs.some((line) => line.includes("missing")));
  logs = [];
  process.env.AGENTX_DEEPSEEK_API_KEY = "test-key";
  await runAuthCommand(["status", "--provider", "deepseek"]);
  assert.ok(logs.some((line) => line.includes("configured via AGENTX_DEEPSEEK_API_KEY")));
  delete process.env.AGENTX_DEEPSEEK_API_KEY;
});

test("runAuthCommand rejects an unknown action", async () => {
  await assert.rejects(() => runAuthCommand(["bogus"]), /Usage: agentx auth/);
});

test("runQuotaCliCommand and the deprecated runUsageCommand --provider path agree", async () => {
  await runQuotaCliCommand(["--provider", "opencode"]);
  const quotaOutput = logs.join("\n");
  logs = [];
  await runUsageCommand(["--provider", "opencode"]);
  assert.ok(errors.some((line) => line.includes("Deprecated")));
  assert.equal(logs.join("\n"), quotaOutput);
});

test("runDoctorCommand honors --client and --offline without touching the network", async () => {
  process.env.AGENTX_DEEPSEEK_API_KEY = "test-key";
  await runDoctorCommand(["--provider", "deepseek", "--client", "claude", "--offline"]);
  delete process.env.AGENTX_DEEPSEEK_API_KEY;
  const output = logs.join("\n");
  assert.match(output, /network checks skipped/);
  assert.match(output, /Claude Code/);
  assert.doesNotMatch(output, /Codex\s+(found|not found)/);
});

test("runForgetCommand prints the stale list in non-interactive mode even when the live catalog fetch fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  try {
    await runForgetCommand([]);
    assert.ok(logs.length > 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("runForgetCommand screens only OpenRouter ids against the catalog — other providers' bare ids are never flagged stale", async () => {
  await saveLastModel("deepseek", "deepseek-v4-pro");
  await saveLastModel("openrouter", "old-vendor/removed-model");
  // Offline snapshot the hydrate path restores; the live fetch below fails and
  // falls back to it, so the screening runs against a known catalog.
  await saveOpenRouterModels(["openai/gpt-4o-mini"]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  try {
    await runForgetCommand([]);
    const output = logs.join("\n");
    assert.match(output, /old-vendor\/removed-model\s+\(no longer in the catalog\)/);
    assert.doesNotMatch(output, /deepseek-v4-pro/);
  } finally {
    globalThis.fetch = originalFetch;
    await forgetRuntime({ provider: "deepseek" });
    await forgetRuntime({ provider: "openrouter" });
  }
});

test("configureMissingProvider returns the key on success and undefined on cancellation", async () => {
  const provider = { id: "deepseek", name: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", models: [] };
  const key = await configureMissingProvider(provider, { promptCredential: async () => "sk-test" });
  assert.equal(key, "sk-test");
  const cancelled = await configureMissingProvider(provider, { promptCredential: async () => { throw new Error("cancelled"); } });
  assert.equal(cancelled, undefined);
});

test("launchClient returns the exit code from a successful run", async () => {
  const code = await launchClient("claude", [], process.env, { runCommand: async () => 0 });
  assert.equal(code, 0);
});

test("launchClient propagates errors that are not a missing executable", async () => {
  await assert.rejects(
    () => launchClient("claude", [], process.env, { runCommand: async () => { throw new Error("boom"); } }),
    /boom/,
  );
});

test("launchClient exits 1 without prompting when the terminal is not interactive", async () => {
  const calls: string[] = [];
  const code = await launchClient("claude", [], process.env, {
    runCommand: async () => { throw new ClientNotFoundError("claude"); },
    confirm: async () => { calls.push("confirm"); return true; },
    runShellCommand: async () => { calls.push("shell"); return 0; },
  });
  assert.equal(code, 1);
  assert.deepEqual(calls, []);
});

function withTTY<T>(run: () => Promise<T>): Promise<T> {
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const stdout = process.stdout as unknown as { isTTY?: boolean };
  const originalStdinTTY = stdin.isTTY; const originalStdoutTTY = stdout.isTTY;
  stdin.isTTY = true; stdout.isTTY = true;
  return run().finally(() => { stdin.isTTY = originalStdinTTY; stdout.isTTY = originalStdoutTTY; });
}

test("launchClient install-recovery flow: user declines the install", async () => {
  let shellCalls = 0;
  const code = await withTTY(() => launchClient("claude", [], process.env, {
    runCommand: async () => { throw new ClientNotFoundError("claude"); },
    confirm: async () => false,
    runShellCommand: async () => { shellCalls++; return 0; },
  }));
  assert.equal(code, 1);
  assert.equal(shellCalls, 0);
  process.exitCode = undefined;
});

test("launchClient install-recovery flow: install succeeds but the executable is still missing", async () => {
  const code = await withTTY(() => launchClient("claude", [], process.env, {
    runCommand: async () => { throw new ClientNotFoundError("claude"); },
    confirm: async () => true,
    runShellCommand: async () => 0,
    executableExists: async () => false,
  }));
  assert.equal(code, 1);
  process.exitCode = undefined;
});

test("launchClient install-recovery flow: install succeeds and the retried launch resolves its exit code", async () => {
  let runCommandCalls = 0;
  const code = await withTTY(() => launchClient("claude", [], process.env, {
    runCommand: async () => { runCommandCalls++; if (runCommandCalls === 1) throw new ClientNotFoundError("claude"); return 0; },
    confirm: async () => true,
    runShellCommand: async () => 0,
    executableExists: async () => true,
  }));
  assert.equal(code, 0);
  assert.equal(runCommandCalls, 2);
});

test("exec injects OpenAI-shaped env vars only when --client-protocol openai is passed", async () => {
  process.env.AGENTX_DEEPSEEK_API_KEY = "test-key";
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const deps = { runCommand: async (_cmd: string, _args: string[], env: NodeJS.ProcessEnv) => { capturedEnv = env; return 0; } };

  await runClientLaunch("exec", ["--provider", "deepseek", "--model", "deepseek-v4-pro", "--", "some-command"], deps);
  assert.ok(capturedEnv?.ANTHROPIC_AUTH_TOKEN, "defaults to Anthropic-shaped env vars");
  assert.equal(capturedEnv?.OPENAI_BASE_URL, undefined);

  await runClientLaunch("exec", ["--provider", "deepseek", "--model", "deepseek-v4-pro", "--client-protocol", "openai", "--", "some-command"], deps);
  assert.ok(capturedEnv?.OPENAI_BASE_URL, "--client-protocol openai switches to OpenAI-shaped env vars");
  assert.equal(capturedEnv?.ANTHROPIC_AUTH_TOKEN, undefined);

  delete process.env.AGENTX_DEEPSEEK_API_KEY;
});

test("exec --base-url registers and persists a custom provider, reusable without repeating the flag", async () => {
  process.env.AGENTX_BENCH_EXEC_API_KEY = "test-key";
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const deps = { runCommand: async (_cmd: string, _args: string[], env: NodeJS.ProcessEnv) => { capturedEnv = env; return 0; } };
  try {
    await runClientLaunch("exec", ["--provider", "Bench Exec", "--base-url", "http://bench.local", "--protocol", "responses", "--model", "m1", "--", "some-command"], deps);
    assert.equal(providerById("bench-exec").models[0].endpoint, "http://bench.local/responses");
    const persisted = await loadCustomProviders();
    assert.deepEqual(persisted["bench-exec"], { name: "Bench Exec", baseUrl: "http://bench.local", protocol: "responses", model: "m1" });
    assert.ok(capturedEnv?.ANTHROPIC_AUTH_TOKEN, "the launch itself still proceeds through the adapter as normal");

    // Second launch reuses the already-registered provider by id, no --base-url needed.
    await runClientLaunch("exec", ["--provider", "bench-exec", "--", "some-command"], deps);
    assert.ok(capturedEnv?.ANTHROPIC_AUTH_TOKEN);
  } finally {
    unregisterCustomProvider("bench-exec");
    delete process.env.AGENTX_BENCH_EXEC_API_KEY;
  }
});

test("an unrecognized command rejects before credential resolution or adapter startup, instead of hanging with a listening adapter", async () => {
  // Before this was fixed, an unknown command only failed inside
  // resolveLaunchTarget *after* startAdapter() had already bound a port —
  // nothing ever closed it, so the process hung forever. Rejecting with the
  // executable-resolution error here (rather than an "API key required"
  // error from credential resolution, which would run first under the old
  // ordering) proves the fix: the command is validated before either step.
  await assert.rejects(() => runClientLaunch("totally-bogus-command", []), /Usage: agentx exec/);
});

test("agentx forget --remove-provider deletes a custom provider but refuses a built-in one", async () => {
  registerCustomProvider({ name: "Removable Exec", baseUrl: "http://x", protocol: "chat-completions" });
  await runForgetCommand(["--provider", "removable-exec", "--remove-provider"]);
  assert.ok(!providerRegistry.some((entry) => entry.id === "removable-exec"));
  assert.equal((await loadCustomProviders())["removable-exec"], undefined);

  await runForgetCommand(["--provider", "opencode", "--remove-provider"]);
  assert.equal(process.exitCode, 1);
  assert.ok(providerRegistry.some((entry) => entry.id === "opencode"));
  process.exitCode = undefined;
});
