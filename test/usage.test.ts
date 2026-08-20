import test from "node:test";
import assert from "node:assert/strict";
import { parseDeepSeekBalance, parseOpenRouterKey } from "../src/usage.js";

test("parses DeepSeek balance", () => {
  const result = parseDeepSeekBalance({ balance_infos: [{ currency: "CNY", total_balance: "12.5" }] });
  assert.equal(result.remaining, 12.5); assert.equal(result.unit, "CNY");
});
test("parses OpenRouter usage and remaining limit", () => {
  const result = parseOpenRouterKey({ data: { usage: 2.5, limit: 10, limit_remaining: 7.5 } });
  assert.equal(result.used, 2.5); assert.equal(result.remaining, 7.5); assert.equal(result.total, 10);
});
