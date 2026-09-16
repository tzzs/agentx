import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `agentx config` is the one place AgentX will write a provider key anywhere:
 * as an `export` line inside a marker block in the user's own shell profile,
 * and only after the user explicitly confirms it. The launch flow stays
 * session-only. Every block is delimited so re-running replaces it in place,
 * and only zsh/bash syntax is supported — anything else falls back to manual
 * instructions (see `shellProfilePath`).
 */

/** Marker lines around the export we manage; the env var name makes each provider's block independently replaceable. */
function blockStart(envName: string): string { return `# >>> agentx credentials: ${envName} >>>`; }
function blockEnd(envName: string): string { return `# <<< agentx credentials: ${envName} <<<`; }

/**
 * Profile file to edit for the current shell, or undefined when we can't
 * write one safely (fish, csh, SHELL unset, …). zsh honors `ZDOTDIR`; bash on
 * macOS is read as `.bash_profile` by login shells (what Terminal.app opens),
 * while other platforms use `.bashrc`.
 */
export function shellProfilePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const shell = env.SHELL?.split("/").pop();
  const home = env.HOME || homedir();
  if (shell === "zsh") return join(env.ZDOTDIR || home, ".zshrc");
  if (shell === "bash") return join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
  return undefined;
}

/** POSIX single-quoting so keys containing spaces, `$`, quotes, or backticks survive the profile. */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Parse back the marker blocks AgentX wrote. Only the exact shape
 * `writeCredentialExport` produces is accepted — shellSingleQuote output with
 * matching names in start, export, and end lines — so a hand-edited block is
 * ignored rather than misread. Returned map is env var name → value.
 */
export function parseCredentialExports(content: string): Map<string, string> {
  const credentials = new Map<string, string>();
  const block = /# >>> agentx credentials: ([A-Za-z_][A-Za-z0-9_]*) >>>\nexport ([A-Za-z_][A-Za-z0-9_]*)=('(?:[^']|'\\'')*')\n# <<< agentx credentials: ([A-Za-z_][A-Za-z0-9_]*) <<</g;
  for (const match of content.matchAll(block)) {
    const [, startName, exportName, raw, endName] = match;
    if (startName !== exportName || startName !== endName) continue;
    credentials.set(startName, raw.slice(1, -1).replaceAll("'\\''", "'"));
  }
  return credentials;
}

/** Read the credential blocks from `file`; a missing or unreadable file yields an empty map. */
export async function readCredentialExports(file: string): Promise<Map<string, string>> {
  try {
    return parseCredentialExports(await readFile(file, "utf8"));
  } catch {
    return new Map();
  }
}

export interface UpsertResult {
  content: string;
  /** False when an existing block already held the same value. */
  changed: boolean;
  /** True when an existing block was replaced instead of appended. */
  replaced: boolean;
}

/** Insert or update the per-variable marker block in `content`, preserving everything around it. */
export function upsertCredentialExport(content: string, envName: string, value: string): UpsertResult {
  const start = blockStart(envName);
  const end = blockEnd(envName);
  const block = `${start}\nexport ${envName}=${shellSingleQuote(value)}\n${end}`;
  const startIndex = content.indexOf(start);
  const endIndex = content.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    const next = content.slice(0, startIndex) + block + content.slice(endIndex + end.length);
    return { content: next, changed: next !== content, replaced: true };
  }
  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return { content: `${content}${separator}${block}\n`, changed: true, replaced: false };
}

export interface ProfileWriteResult {
  file: string;
  changed: boolean;
  /** Path of the pre-write backup, present whenever an existing profile was modified. */
  backup?: string;
  replaced: boolean;
  /** Final POSIX file mode after the write, for the "other users can read this" warning; undefined on Windows, which has no POSIX modes. */
  mode?: number;
}

/**
 * Write the export block to `file`. A pre-existing profile is backed up to
 * `<file>.agentx.bak` before its first modification; a fresh file is created
 * with 0600. Existing files keep their permissions — the caller warns when
 * they are group/world-readable, since the profile now holds a secret.
 * Windows has no POSIX modes, so no mode is reported there (and the caller
 * skips the chmod advice, which would be pure noise).
 */
export async function writeCredentialExport(file: string, envName: string, value: string): Promise<ProfileWriteResult> {
  const posix = process.platform !== "win32";
  let existing = "";
  let mode: number | undefined;
  try {
    existing = await readFile(file, "utf8");
    mode = posix ? (await stat(file)).mode & 0o777 : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { content, changed, replaced } = upsertCredentialExport(existing, envName, value);
  if (!changed) return { file, changed: false, replaced, mode };
  let backup: string | undefined;
  if (existing) {
    backup = `${file}.agentx.bak`;
    await copyFile(file, backup);
  }
  await writeFile(file, content, { mode: mode ?? 0o600 });
  return { file, changed: true, backup, replaced, mode: mode ?? (posix ? 0o600 : undefined) };
}
