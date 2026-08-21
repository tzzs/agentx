import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageStore, defaultUsageStore, defaultUsageLocation, periodStart, sqliteAvailable } from "../src/usage/storage.js";
import { TokenUsageCollector, normalizeUsage } from "../src/usage/collector.js";
import { loadStatsStore } from "../src/usage/cli.js";
import type { TokenUsage } from "../src/usage/types.js";

const now = Date.now();

function sample(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return { provider: "openai", model: "gpt-4o", inputTokens: 100, outputTokens: 50, totalTokens: 150, timestamp: now, ...overrides };
}

for (const backend of ["sqlite", "memory", "json"] as const) {
  test(`normalizes and stores usage (${backend})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentx-usage-"));
    try {
      const store = await createUsageStore({ backend: backend === "json" ? "json" : backend, location: join(dir, "usage.json") });
      const collector = new TokenUsageCollector(store);
      await collector.record(sample({ provider: "openai", model: "gpt-4o", sessionId: "s1" }));
      await collector.record(sample({ provider: "anthropic", model: "claude-sonnet-4", sessionId: "s1", inputTokens: 200, outputTokens: 100, totalTokens: 300 }));
      await collector.record(sample({ provider: "openai", model: "gpt-4o", sessionId: "s2" }));
      const totals = await store.totals("all");
      assert.deepEqual(totals, { inputTokens: 400, outputTokens: 200, totalTokens: 600 });
      const session = await store.sessionTotals("s1");
      assert.deepEqual(session, { inputTokens: 300, outputTokens: 150, totalTokens: 450 });
      const providers = await store.providerStats("all");
      assert.deepEqual(providers, [{ provider: "anthropic", tokens: 300, requests: 1 }, { provider: "openai", tokens: 300, requests: 2 }]);
      const models = await store.modelStats("all");
      assert.deepEqual(models, [{ provider: "anthropic", model: "claude-sonnet-4", tokens: 300, requests: 1 }, { provider: "openai", model: "gpt-4o", tokens: 300, requests: 2 }]);
      await store.close();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("filters by time range", async () => {
  const store = await createUsageStore({ backend: "memory" });
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  await store.record(normalizeUsage(sample({ timestamp: now })));
  await store.record(normalizeUsage(sample({ timestamp: old })));
  const today = await store.totals("today");
  assert.equal(today.totalTokens, 150);
  const week = await store.totals("week");
  assert.equal(week.totalTokens, 150);
  const month = await store.totals("month");
  assert.equal(month.totalTokens, 300);
  await store.close();
});

test("computes period start timestamps", () => {
  assert.equal(periodStart("all"), undefined);
  assert.ok(periodStart("today")! > periodStart("week")!);
  assert.ok(periodStart("week")! > periodStart("month")!);
});

test("sqlite backend availability is reported", async () => {
  const available = await sqliteAvailable();
  assert.equal(typeof available, "boolean");
});

test("normalizeUsage fills missing defaults", () => {
  const row = normalizeUsage({ provider: "p", model: "m", inputTokens: 100, outputTokens: 50 });
  assert.deepEqual(row, { provider: "p", model: "m", inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedTokens: 0, reasoningTokens: 0, estimated: false, sessionId: null, createdAt: row.createdAt });
  assert.equal(Number.isFinite(row.createdAt), true);
});

test("the CLI statistics store uses the same location as the adapter server", async () => {
  const originalDir = process.env.AGENTX_USAGE_DIR;
  const originalBackend = process.env.AGENTX_USAGE_BACKEND;
  const dir = await mkdtemp(join(tmpdir(), "agentx-usage-path-"));
  try {
    process.env.AGENTX_USAGE_DIR = dir;
    delete process.env.AGENTX_USAGE_BACKEND;
    const serverStore = await defaultUsageStore();
    const cliStore = await loadStatsStore();
    assert.equal(cliStore.constructor.name, serverStore.constructor.name);
    await serverStore.record(normalizeUsage({ provider: "p", model: "m", inputTokens: 10, outputTokens: 5 }));
    const totals = await cliStore.totals("all");
    assert.equal(totals.totalTokens, 15);
    await serverStore.close();
    await cliStore.close();
    assert.equal(process.env.AGENTX_USAGE_BACKEND === undefined, true);
  } finally {
    if (originalDir === undefined) delete process.env.AGENTX_USAGE_DIR; else process.env.AGENTX_USAGE_DIR = originalDir;
    if (originalBackend === undefined) delete process.env.AGENTX_USAGE_BACKEND; else process.env.AGENTX_USAGE_BACKEND = originalBackend;
    await rm(dir, { recursive: true, force: true });
  }
});

test("json file store handles concurrent reads after a write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentx-usage-json-"));
  try {
    const store = await createUsageStore({ backend: "json", location: join(dir, "usage.json") });
    await store.record(normalizeUsage({ provider: "p", model: "m", inputTokens: 100, outputTokens: 25 }));
    const [models, totals] = await Promise.all([store.modelStats("all"), store.totals("all")]);
    assert.equal(totals.inputTokens, 100);
    assert.equal(totals.outputTokens, 25);
    assert.equal(models[0].tokens, 125);
    await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});