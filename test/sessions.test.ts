import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySessionRecord, discoverClaudeSessionId, discoverCodexSessionId, resumeSessionId } from "../src/sessions.js";
import type { SessionRecord } from "../src/runtime.js";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";

test("resumeSessionId extracts a literal UUID from claude's --resume/-r flag", () => {
  assert.equal(resumeSessionId("claude", ["--resume", CLAUDE_ID]), CLAUDE_ID);
  assert.equal(resumeSessionId("claude", ["-r", CLAUDE_ID]), CLAUDE_ID);
  assert.equal(resumeSessionId("claude", [`--resume=${CLAUDE_ID}`]), CLAUDE_ID);
});

test("resumeSessionId ignores a search term or a bare flag — the picker's outcome isn't knowable ahead of launch", () => {
  assert.equal(resumeSessionId("claude", ["--resume", "fix the bug"]), undefined);
  assert.equal(resumeSessionId("claude", ["--resume"]), undefined);
  assert.equal(resumeSessionId("claude", ["--continue"]), undefined);
  assert.equal(resumeSessionId("claude", []), undefined);
});

test("resumeSessionId extracts a literal UUID from codex's `resume` subcommand", () => {
  assert.equal(resumeSessionId("codex", ["resume", CODEX_ID]), CODEX_ID);
  assert.equal(resumeSessionId("codex", ["--approve-for-me", "resume", CODEX_ID]), CODEX_ID);
});

test("resumeSessionId ignores codex resume without a parseable id", () => {
  assert.equal(resumeSessionId("codex", ["resume", "--last"]), undefined);
  assert.equal(resumeSessionId("codex", ["resume"]), undefined);
  assert.equal(resumeSessionId("codex", ["fork", CODEX_ID]), undefined);
});

test("applySessionRecord fills in a recalled agentx routing when nothing explicit was given", () => {
  const record: SessionRecord = { client: "claude", mode: "agentx", provider: "deepseek", model: "deepseek-v4-pro", recordedAt: 1 };
  const result = applySessionRecord({}, false, record);
  assert.equal(result.applied, true);
  assert.equal(result.forceNative, false);
  assert.deepEqual(result.opts, { provider: "deepseek", model: "deepseek-v4-pro" });
});

test("applySessionRecord requests a native relaunch for a native-mode record", () => {
  const record: SessionRecord = { client: "claude", mode: "native", recordedAt: 1 };
  const result = applySessionRecord({}, false, record);
  assert.equal(result.applied, true);
  assert.equal(result.forceNative, true);
  assert.deepEqual(result.opts, {});
});

test("applySessionRecord never overrides an explicit --provider/--model", () => {
  const record: SessionRecord = { client: "claude", mode: "native", recordedAt: 1 };
  const result = applySessionRecord({ model: "gpt-5.6-luna" }, false, record);
  assert.equal(result.applied, false);
  assert.equal(result.forceNative, false);
  assert.deepEqual(result.opts, { model: "gpt-5.6-luna" });
});

test("applySessionRecord never overrides an explicit --native flag", () => {
  const record: SessionRecord = { client: "claude", mode: "agentx", provider: "deepseek", model: "deepseek-v4-pro", recordedAt: 1 };
  const result = applySessionRecord({}, true, record);
  assert.equal(result.applied, false);
  assert.equal(result.forceNative, false);
});

test("applySessionRecord respects AGENTX_PROVIDER/AGENTX_MODEL as explicit routing too", () => {
  const record: SessionRecord = { client: "claude", mode: "native", recordedAt: 1 };
  process.env.AGENTX_MODEL = "gpt-5.6-luna";
  try {
    const result = applySessionRecord({}, false, record);
    assert.equal(result.applied, false);
  } finally {
    delete process.env.AGENTX_MODEL;
  }
});

test("applySessionRecord is a no-op when there is no recalled record", () => {
  const result = applySessionRecord({ model: "x" }, false, undefined);
  assert.equal(result.applied, false);
  assert.deepEqual(result.opts, { model: "x" });
});

let dir: string;
test.before(async () => { dir = await mkdtemp(join(tmpdir(), "agentx-sessions-")); });
test.after(async () => { await rm(dir, { recursive: true, force: true }); });

test("discoverClaudeSessionId finds the single session file touched since a given time", async () => {
  const projectsDir = join(dir, "claude-projects-1");
  const projectDir = join(projectsDir, "-home-user-repo");
  await mkdir(projectDir, { recursive: true });
  const staleFile = join(projectDir, "33333333-3333-4333-8333-333333333333.jsonl");
  const freshFile = join(projectDir, `${CLAUDE_ID}.jsonl`);
  await writeFile(staleFile, "{}");
  await utimes(staleFile, new Date(1000), new Date(1000));

  const since = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(freshFile, "{}");

  assert.equal(await discoverClaudeSessionId(since, projectsDir), CLAUDE_ID);
});

test("discoverClaudeSessionId returns undefined when nothing changed, and when more than one file changed", async () => {
  const projectsDir = join(dir, "claude-projects-2");
  const projectDir = join(projectsDir, "-home-user-repo");
  await mkdir(projectDir, { recursive: true });

  const since = Date.now();
  assert.equal(await discoverClaudeSessionId(since, projectsDir), undefined);

  // A short delay guarantees both writes land strictly after `since` — without it,
  // filesystem mtime rounding can put one write on either side of the boundary,
  // making only one file register as a hit and flaking the "ambiguous" assertion below.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(projectDir, `${CLAUDE_ID}.jsonl`), "{}");
  await writeFile(join(projectDir, "44444444-4444-4444-8444-444444444444.jsonl"), "{}");
  // Two files touched in the same window is ambiguous — better to record nothing than guess.
  assert.equal(await discoverClaudeSessionId(since, projectsDir), undefined);
});

test("discoverClaudeSessionId ignores non-session files", async () => {
  const projectsDir = join(dir, "claude-projects-3");
  const projectDir = join(projectsDir, "-home-user-repo");
  await mkdir(projectDir, { recursive: true });
  const since = Date.now();
  await writeFile(join(projectDir, "not-a-session-id.jsonl"), "{}");
  await writeFile(join(projectDir, "readme.txt"), "hi");
  assert.equal(await discoverClaudeSessionId(since, projectsDir), undefined);
});

test("discoverCodexSessionId finds today's rollout file touched since a given time", async () => {
  const sessionsDir = join(dir, "codex-sessions-1");
  const now = new Date();
  const dayDir = join(sessionsDir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  await mkdir(dayDir, { recursive: true });
  const since = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(dayDir, `rollout-2026-09-02T01-00-00-${CODEX_ID}.jsonl`), "{}");
  assert.equal(await discoverCodexSessionId(since, sessionsDir), CODEX_ID);
});

test("discoverCodexSessionId falls back to a full scan when today's partition has nothing new", async () => {
  const sessionsDir = join(dir, "codex-sessions-2");
  const oldDayDir = join(sessionsDir, "2025", "01", "15");
  await mkdir(oldDayDir, { recursive: true });
  const since = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(join(oldDayDir, `rollout-2025-01-15T01-00-00-${CODEX_ID}.jsonl`), "{}");
  assert.equal(await discoverCodexSessionId(since, sessionsDir), CODEX_ID);
});
