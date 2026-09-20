import test from "node:test";
import assert from "node:assert/strict";
import { checkUpstream, modelListUrl, renderDoctor, type DoctorResult } from "../src/doctor.js";
import type { ProviderModel } from "../src/providers/types.js";

const base: DoctorResult = {
  nodeVersion: "v24.0.0",
  platform: "linux",
  architecture: "x64",
  providerId: "opencode",
  providerName: "OpenCode",
  apiKey: "secret",
  apiKeyFound: true,
  models: [{ provider: "opencode", model: "gpt-5.6-luna" }],
  clientsChecked: ["all"],
  claudeFound: true,
  codexFound: false,
  portAvailable: true,
  networkChecksSkipped: false,
  upstream: { checked: true, reachable: true, authorized: true },
  issues: [],
};

test("renders a ready status when there are no issues", () => {
  const output = renderDoctor(base);
  assert.match(output, /Status: Ready/);
  assert.doesNotMatch(output, /Issues/);
});

test("lists issues and reports a not-ready status", () => {
  const output = renderDoctor({ ...base, apiKeyFound: false, issues: ["Set AGENTX_OPENCODE_API_KEY (or OPENCODE_API_KEY) before starting the adapter, or pass --api-key <key>."] });
  assert.match(output, /Status: Not ready/);
  assert.match(output, /- Set AGENTX_OPENCODE_API_KEY/);
});

test("marks missing API key and clients with a cross", () => {
  const output = renderDoctor({ ...base, apiKeyFound: false, codexFound: false });
  assert.match(output, /✗ API key\s+missing/);
  assert.match(output, /✗ Codex\s+not found/);
});

test("omits unselected clients from the report", () => {
  const output = renderDoctor({ ...base, clientsChecked: ["claude"], codexFound: false });
  assert.match(output, /Claude Code\s+found/);
  assert.doesNotMatch(output, /Codex\s+not found/);
  assert.doesNotMatch(output, /Codex\s+found/);
});

test("flags when network checks are skipped", () => {
  const output = renderDoctor({ ...base, networkChecksSkipped: true });
  assert.match(output, /network checks skipped/);
});

// --- upstream probe ---------------------------------------------------------
// `--offline` used to gate nothing at all: doctor made no network call, so it
// could report a key as "found" but never as accepted.

const chatModel: ProviderModel = { provider: "opencode", model: "glm-5", protocol: "chat-completions", endpoint: "https://upstream.invalid/v1/chat/completions" };

test("checkUpstream derives the model list URL from the request endpoint", async () => {
  let requested = "";
  const result = await checkUpstream(chatModel, "key", (async (url: any) => { requested = String(url); return new Response("{}", { status: 200 }); }) as typeof fetch);
  assert.equal(requested, "https://upstream.invalid/v1/models");
  assert.deepEqual(result, { checked: true, reachable: true, authorized: true });
});

test("checkUpstream reports a rejected key as reachable but unauthorized", async () => {
  const result = await checkUpstream(chatModel, "bad", (async () => new Response("{}", { status: 401 })) as typeof fetch);
  assert.equal(result.reachable, true);
  assert.equal(result.authorized, false);
  assert.match(result.message ?? "", /rejected the API key/);
});

test("checkUpstream reports an unreachable endpoint without throwing", async () => {
  const result = await checkUpstream(chatModel, "key", (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch);
  assert.deepEqual(result, { checked: true, reachable: false, authorized: false, message: "getaddrinfo ENOTFOUND" });
});

test("checkUpstream sends the provider's own headers and Anthropic's auth pair", async () => {
  const anthropicModel: ProviderModel = { provider: "custom", model: "claude-x", protocol: "anthropic", endpoint: "https://gw.invalid/v1/messages", headers: { "X-Gateway": "on" } };
  let seen: Headers | undefined;
  await checkUpstream(anthropicModel, "key", (async (_url: any, init?: any) => { seen = new Headers(init?.headers); return new Response("{}", { status: 200 }); }) as typeof fetch);
  assert.equal(seen?.get("x-gateway"), "on");
  assert.equal(seen?.get("x-api-key"), "key");
  assert.equal(seen?.get("anthropic-version"), "2023-06-01");
});

test("checkUpstream skips the probe when there is no key to test", async () => {
  const result = await checkUpstream(chatModel, "", (async () => { throw new Error("must not be called"); }) as typeof fetch);
  assert.match(result.message ?? "", /no API key/);
});

test("renders the upstream line only once the probe actually ran", () => {
  assert.doesNotMatch(renderDoctor({ ...base, upstream: { checked: false, reachable: false, authorized: false } }), /Upstream/);
  assert.match(renderDoctor(base), /✓ Upstream/);
  assert.match(renderDoctor({ ...base, upstream: { checked: true, reachable: true, authorized: false, message: "rejected the API key (HTTP 401)" } }), /✗ Upstream {6}rejected the API key/);
});

test("modelListUrl handles every protocol's endpoint shape", () => {
  assert.equal(modelListUrl("https://api.deepseek.com/v1/chat/completions"), "https://api.deepseek.com/v1/models");
  assert.equal(modelListUrl("https://opencode.ai/zen/go/v1/responses"), "https://opencode.ai/zen/go/v1/models");
  assert.equal(modelListUrl("https://gw.invalid/v1/messages"), "https://gw.invalid/v1/models");
  assert.equal(modelListUrl("https://gw.invalid/custom/path"), "https://gw.invalid/custom/models");
});
