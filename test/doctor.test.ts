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
  clientsChecked: ["all"],
  claudeFound: true,
  codexFound: false,
  portAvailable: true,
  networkChecksSkipped: false,
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
