import test from "node:test";
import assert from "node:assert/strict";
import { renderDoctor, type DoctorResult } from "../src/doctor.js";

const base: DoctorResult = {
  nodeVersion: "v24.0.0",
  platform: "linux",
  architecture: "x64",
  providerId: "opencode",
  providerName: "OpenCode",
  apiKey: "secret",
  apiKeyFound: true,
  models: [{ provider: "opencode", model: "gpt-5.6-luna" }],
  claudeFound: true,
  codexFound: false,
  portAvailable: true,
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
