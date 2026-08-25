import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { backgroundModel, clientEnvironment, codexLaunchArgs, runCommand, ClientNotFoundError } from "../src/process.js";

test("injects OpenAI environment for Codex", async () => {
  const adapter = { port: 8788, token: "local-token" } as any;
  const config = { host: "127.0.0.1", port: 8787, model: "gpt-5.6-luna", apiKey: "upstream", logLevel: "info" };
  const env = clientEnvironment(config, adapter, "openai");
  assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:8788/v1"); assert.equal(env.OPENAI_API_KEY, "local-token"); assert.equal(env.OPENAI_MODEL, "gpt-5.6-luna");
  const anthropicEnv = clientEnvironment(config, adapter, "anthropic");
  assert.equal(anthropicEnv.ANTHROPIC_MODEL, "gpt-5.6-luna"); assert.equal(anthropicEnv.ANTHROPIC_AUTH_TOKEN, "local-token"); assert.equal(anthropicEnv.ANTHROPIC_API_KEY, undefined);
});

test("points Codex at the local adapter via -c provider overrides", () => {
  const adapter = { port: 8788, token: "local-token" } as any;
  const config = { host: "127.0.0.1", port: 8787, model: "gpt-5.6-luna", apiKey: "upstream", logLevel: "info" };
  assert.deepEqual(codexLaunchArgs(config as any, adapter), [
    "-c", "model_provider='agentx'",
    "-c", "model_providers.agentx.name='AgentX'",
    "-c", "model_providers.agentx.base_url='http://127.0.0.1:8788/v1'",
    "-c", "model_providers.agentx.wire_api='responses'",
    "-c", "model_providers.agentx.env_key='OPENAI_API_KEY'",
    "-m", "gpt-5.6-luna",
  ]);
});

test("attaches the generated model catalog when one was written", () => {
  const adapter = { port: 8788, token: "tok" } as any;
  const config = { host: "127.0.0.1", port: 8787, model: "auto", apiKey: "k", logLevel: "info" };
  const args = codexLaunchArgs(config as any, adapter, "/tmp/catalog/models.json");
  assert.deepEqual(args.slice(10), ["-c", "model_catalog_json='/tmp/catalog/models.json'"]);
  assert.ok(!args.includes("-m"));
});

test("keeps every Claude Code tier on the selected model by default", async () => {
  const adapter = { port: 8788, token: "local-token" } as any;
  const config = { host: "127.0.0.1", port: 8787, model: "gpt-5.6-luna", apiKey: "k", logLevel: "info" };
  const env = clientEnvironment(config, adapter, "anthropic");
  // User choice wins by default: no tier is silently redirected elsewhere.
  assert.equal(env.ANTHROPIC_MODEL, "gpt-5.6-luna");
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-5.6-luna");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "gpt-5.6-luna");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gpt-5.6-luna");
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "gpt-5.6-luna");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "gpt-5.6-luna");
});

test("routes the background lane elsewhere only when explicitly configured", () => {
  // Opt-in override for the haiku/background tier.
  const optedIn = { host: "127.0.0.1", port: 8787, model: "gpt-5.6-luna", apiKey: "k", logLevel: "info", backgroundModel: "deepseek-v4-flash" };
  assert.equal(backgroundModel(optedIn), "deepseek-v4-flash");
  // An unresolvable override must not break startup; the main model is kept.
  const unknown = { host: "127.0.0.1", port: 8787, model: "gpt-5.6-luna", apiKey: "k", logLevel: "info", backgroundModel: "no-such-model" };
  assert.equal(backgroundModel(unknown), "gpt-5.6-luna");
  // Same value as the main model is a no-op.
  const same = { host: "127.0.0.1", port: 8787, model: "ox-alpha-free", apiKey: "k", logLevel: "info", backgroundModel: "ox-alpha-free" };
  assert.equal(backgroundModel(same), "ox-alpha-free");
});

test("reports a missing client executable with a typed, actionable error", async () => {
  const adapter = { port: 8788, token: "tok" } as any;
  const config = { host: "127.0.0.1", port: 8787, model: "gpt-5.6-luna", apiKey: "k", logLevel: "info" };
  await assert.rejects(
    () => runCommand("agentx-no-such-client-xyz", [], config as any, adapter, "anthropic"),
    (error: any) => error instanceof ClientNotFoundError && error.executable === "agentx-no-such-client-xyz"
      && /not installed or not on PATH/.test(error.message),
  );
});

async function waitForFile(path: string, child?: any, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) return;
    if (child?.exitCode != null) throw new Error(`helper exited with code ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("forwards SIGTERM but not SIGINT to the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentx-sig-"));
  const parentPidFile = join(dir, "parent.pid");
  const childPidFile = join(dir, "child.pid");
  const signalsFile = join(dir, "signals.log");
  const resultFile = join(dir, "result.log");
  const childScript = join(dir, "child.mjs");
  const helperScript = join(dir, "helper.mjs");

  writeFileSync(childScript, `
import fs from "node:fs";
const pidFile = ${JSON.stringify(childPidFile)};
const logFile = ${JSON.stringify(signalsFile)};
fs.writeFileSync(logFile, "");
fs.writeFileSync(pidFile, String(process.pid));
process.on("SIGINT", () => fs.appendFileSync(logFile, "sigint\\n"));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`.trim() + "\n");

  const processModule = new URL("../src/process.js", import.meta.url).href;
  writeFileSync(helperScript, `
import { runCommand } from ${JSON.stringify(processModule)};
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));
const config = { host: "127.0.0.1", model: "gpt-5.6-luna", apiKey: "k", logLevel: "info" };
const adapter = { port: 8788, token: "tok" };
const code = await runCommand(process.execPath, [${JSON.stringify(childScript)}], config, adapter, "anthropic");
fs.writeFileSync(${JSON.stringify(resultFile)}, "exit:" + code);
process.exit(0);
`.trim() + "\n");

  const child = spawn(process.execPath, [helperScript], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  try {
    await waitForFile(parentPidFile, child);
    await waitForFile(childPidFile, child);
    const parentPid = Number(readFileSync(parentPidFile, "utf8"));
    const childPid = Number(readFileSync(childPidFile, "utf8"));
    assert.ok(parentPid > 0 && childPid > 0);

    // The child shares the terminal process group, so a terminal SIGINT already
    // reaches it directly. The parent must NOT forward a second one, which the
    // child would treat as a forced abort. Sending SIGINT to the parent only must
    // therefore leave the child untouched.
    process.kill(parentPid, "SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(readFileSync(signalsFile, "utf8"), "", "parent forwarded SIGINT to the child");

    // SIGTERM targeted at the parent alone (e.g. `kill <pid>`) must be forwarded
    // so the child shuts down gracefully. The child exits(0) on SIGTERM.
    process.kill(parentPid, "SIGTERM");
    await waitForFile(resultFile, child);
    assert.equal(readFileSync(resultFile, "utf8"), "exit:0");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(dir, { recursive: true, force: true });
  }
});
