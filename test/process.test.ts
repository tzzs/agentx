import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { clientEnvironment, runCommand } from "../src/process.js";

test("injects OpenAI environment for Codex", async () => {
  const adapter = { port: 8788, token: "local-token" } as any;
  const config = { host: "127.0.0.1", port: 8787, model: "gpt-5.6-luna", apiKey: "upstream", logLevel: "info" };
  const env = clientEnvironment(config, adapter, "openai");
  assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:8788/v1"); assert.equal(env.OPENAI_API_KEY, "local-token"); assert.equal(env.OPENAI_MODEL, "gpt-5.6-luna");
  const anthropicEnv = clientEnvironment(config, adapter, "anthropic");
  assert.equal(anthropicEnv.ANTHROPIC_MODEL, "gpt-5.6-luna"); assert.equal(anthropicEnv.ANTHROPIC_AUTH_TOKEN, "local-token"); assert.equal(anthropicEnv.ANTHROPIC_API_KEY, undefined);
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
