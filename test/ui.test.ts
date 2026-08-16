import test from "node:test";
import assert from "node:assert/strict";
import { providers } from "../src/catalog.js";
import { selectableProviders, selectModel } from "../src/ui.js";

test("offers the configured catalog to both clients", () => {
  assert.equal(selectableProviders("claude").length, providers.length);
  assert.equal(selectableProviders("codex").length, providers.length);
});

test("falls back to the first model in non-interactive mode", async () => {
  assert.equal((await selectModel("claude", providers.slice(0, 2))).model, providers[0].model);
});
