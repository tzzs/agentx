import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "./runtime.js";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function uuidOrUndefined(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined;
}

/**
 * An explicit resume target, only when given as a literal session UUID.
 * Claude's `--resume [value]` and Codex's `resume [SESSION_ID]` both also
 * accept a bare flag or a search term to open an interactive picker, and
 * which session that picker lands on isn't knowable ahead of the launch —
 * so anything that doesn't parse as a UUID is left alone.
 */
export function resumeSessionId(client: "claude" | "codex", commandArgs: string[]): string | undefined {
  if (client === "claude") {
    for (let i = 0; i < commandArgs.length; i++) {
      const arg = commandArgs[i];
      if (arg === "--resume" || arg === "-r") return uuidOrUndefined(commandArgs[i + 1]);
      if (arg.startsWith("--resume=")) return uuidOrUndefined(arg.slice("--resume=".length));
    }
    return undefined;
  }
  const index = commandArgs.indexOf("resume");
  return index === -1 ? undefined : uuidOrUndefined(commandArgs[index + 1]);
}

/**
 * Decide how a recalled session record should adjust this launch. Any
 * explicit routing the user already gave — `--native`, `--provider`/`--model`,
 * or their env equivalents — always wins; the record only fills in when the
 * launch would otherwise fall back to asking (interactive picker or the
 * built-in default).
 */
export function applySessionRecord(
  opts: Record<string, string | undefined>,
  nativeExplicitlyRequested: boolean,
  record: SessionRecord | undefined,
): { opts: Record<string, string | undefined>; forceNative: boolean; applied: boolean } {
  const explicitRouting = nativeExplicitlyRequested
    || Boolean(opts.provider || opts.model || process.env.AGENTX_PROVIDER || process.env.AGENTX_MODEL);
  if (!record || explicitRouting) return { opts, forceNative: false, applied: false };
  if (record.mode === "native") return { opts, forceNative: true, applied: true };
  return { opts: { ...opts, provider: record.provider, model: record.model }, forceNative: false, applied: true };
}

/**
 * Walk `root` (bounded to `maxDepth` subdirectory levels) for files whose
 * name yields an id via `idFromName` and whose mtime is at or after `since`.
 * More than one hit in the window is ambiguous — e.g. a concurrent session
 * elsewhere touched a file too — and it's better to record nothing than to
 * guess wrong, so only an exact single match is returned.
 */
async function newestTouchedId(root: string, idFromName: (name: string) => string | undefined, since: number, maxDepth: number): Promise<string | undefined> {
  const hits: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < maxDepth) await walk(full, depth + 1); continue; }
      const id = idFromName(entry.name);
      if (!id) continue;
      try { if ((await stat(full)).mtimeMs >= since) hits.push(id); } catch { /* file vanished mid-scan */ }
    }
  }
  await walk(root, 0);
  return hits.length === 1 ? hits[0] : undefined;
}

const CLAUDE_SESSION_FILE_RE = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/**
 * Best-effort: the session id of the transcript file Claude Code just wrote
 * to (new session or resume), found by scanning `~/.claude/projects/<project>/
 * <session-id>.jsonl` for the one file touched since the launch started.
 * This relies on Claude Code's on-disk layout, which is undocumented and can
 * change between versions — callers must treat "not found" as routine, not
 * an error.
 */
export async function discoverClaudeSessionId(since: number, projectsDir = join(homedir(), ".claude", "projects")): Promise<string | undefined> {
  return newestTouchedId(projectsDir, (name) => CLAUDE_SESSION_FILE_RE.exec(name)?.[1], since, 1);
}

const CODEX_ROLLOUT_FILE_RE = /^rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

/**
 * Best-effort: the session id of the rollout file Codex just wrote to.
 * Sessions are partitioned under `~/.codex/sessions/<year>/<month>/<day>/`;
 * today's partition is tried first and a full scan is the fallback for a
 * launch that straddled a day boundary. Same on-disk-layout caveat as
 * {@link discoverClaudeSessionId}.
 */
export async function discoverCodexSessionId(since: number, sessionsDir = join(homedir(), ".codex", "sessions")): Promise<string | undefined> {
  const now = new Date();
  const todayDir = join(sessionsDir, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  const idFromName = (name: string) => CODEX_ROLLOUT_FILE_RE.exec(name)?.[1];
  const fast = await newestTouchedId(todayDir, idFromName, since, 0);
  if (fast) return fast;
  return newestTouchedId(sessionsDir, idFromName, since, 3);
}
