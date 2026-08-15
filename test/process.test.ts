import test from "node:test";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/process.js";

test("injects OpenAI environment for Codex", async () => {
  const adapter = { port: 8788, token: "local-token" } as any;
  const config = { host: "127.0.0.1", port: 8787, model: "gpt-5.6-luna", apiKey: "upstream", logLevel: "info" };
  const env = clientEnvironment(config, adapter, "openai");
  assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:8788/v1"); assert.equal(env.OPENAI_API_KEY, "local-token"); assert.equal(env.OPENAI_MODEL, "gpt-5.6-luna");
  assert.equal(clientEnvironment(config, adapter, "anthropic").ANTHROPIC_MODEL, "sonnet");
});
