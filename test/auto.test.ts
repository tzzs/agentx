import test from "node:test";
import assert from "node:assert/strict";
import { selectModel } from "../src/catalog.js";

test("auto routing selects a lightweight model for short prompts", () => {
  assert.equal(selectModel({ messages: [{ role: "user", content: "Hi" }] }, "auto"), "deepseek-v4-flash");
});
test("auto routing selects Luna when tools are present", () => {
  assert.equal(selectModel({ messages: [{ role: "user", content: "Hi" }], tools: [{ name: "bash", input_schema: {} }] }, "auto"), "gpt-5.6-luna");
});
