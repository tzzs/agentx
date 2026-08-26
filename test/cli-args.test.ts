import test from "node:test";
import assert from "node:assert/strict";
import { clientArguments } from "../src/cli.js";

test("strips adapter flags and their values from client arguments", () => {
  assert.deepEqual(clientArguments(["--model", "m", "--continue"]), ["--continue"]);
  assert.deepEqual(clientArguments(["--verbose", "--port", "9000", "-p"]), ["-p"]);
});

test("strips inline --flag=value forms", () => {
  assert.deepEqual(clientArguments(["--model=gpt-x", "--resume", "abc"]), ["--resume", "abc"]);
  assert.deepEqual(clientArguments(["--api-key=sk-test"]), []);
});

test("keeps client flags that merely look similar", () => {
  assert.deepEqual(clientArguments(["--model-settings", "{}"]), ["--model-settings", "{}"]);
});

test("codex and pi arguments are forwarded (not dropped)", () => {
  assert.deepEqual(clientArguments(["--approve-for-me", "resume", "abc"]), ["--approve-for-me", "resume", "abc"]);
  assert.deepEqual(clientArguments(["--quiet"]), ["--quiet"]);
  assert.deepEqual(clientArguments(["--model", "gpt-4", "--resume", "abc"]), ["--resume", "abc"]);
});
