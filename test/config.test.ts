import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

let configDir: string;

test.before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-config-test-"));
  const agentxDir = join(configDir, "agentx");
  await mkdir(agentxDir, { recursive: true });
  process.env.XDG_CONFIG_HOME = configDir;
});

test.after(async () => { delete process.env.XDG_CONFIG_HOME; await rm(configDir, { recursive: true, force: true }); });

test("falls back to the default model when nothing was remembered", () => {
  assert.equal(loadConfig({}).model, "gpt-5.6-luna");
});

test("remembers the last used model when no model is specified", async () => {
  await writeFile(join(configDir, "agentx", "profiles.json"), JSON.stringify([{ id: "opencode/deepseek-v4-flash", provider: "opencode", model: "deepseek-v4-flash" }], null, 2));
  assert.equal(loadConfig({}).model, "deepseek-v4-flash");
});

test("remembers the last used model only for the matching provider", async () => {
  await writeFile(join(configDir, "agentx", "profiles.json"), JSON.stringify([{ id: "opencode/deepseek-v4-flash", provider: "opencode", model: "deepseek-v4-flash" }], null, 2));
  assert.equal(loadConfig({ provider: "openrouter" }).model, "openai/gpt-4o-mini");
});

test("explicit --model takes precedence over the remembered model", async () => {
  await writeFile(join(configDir, "agentx", "profiles.json"), JSON.stringify([{ id: "opencode/deepseek-v4-flash", provider: "opencode", model: "deepseek-v4-flash" }], null, 2));
  assert.equal(loadConfig({ model: "gpt-5.6-luna" }).model, "gpt-5.6-luna");
});

test("AGENTX_MODEL takes precedence over the remembered model", async () => {
  await writeFile(join(configDir, "agentx", "profiles.json"), JSON.stringify([{ id: "opencode/deepseek-v4-flash", provider: "opencode", model: "deepseek-v4-flash" }], null, 2));
  process.env.AGENTX_MODEL = "deepseek-v4-pro";
  try { assert.equal(loadConfig({}).model, "deepseek-v4-pro"); }
  finally { delete process.env.AGENTX_MODEL; }
});
