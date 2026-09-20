import { defaultModelFor } from "./selection.js";

/** Full Codex reasoning-effort scale (ReasoningEffort); max/ultra live behind Codex's Advanced Reasoning step. */
export const CODEX_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
/** Claude Code's effort levels; `ultracode` is its workflow mode that runs at xhigh. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "ultracode"] as const;
export type ReasoningEffort = (typeof CODEX_EFFORT_LEVELS)[number] | (typeof CLAUDE_EFFORT_LEVELS)[number];

export interface Config {
  host: string;
  port: number;
  model: string;
  provider?: string;
  /** Optional override for Claude Code's background/haiku tier; unset = same as model. */
  backgroundModel?: string;
  /** Optional reasoning effort; forwarded to the client's own flag. Per-client validation happens at launch. */
  effort?: ReasoningEffort;
  apiKey: string;
  logLevel: string;
  /** Retry attempts on upstream network failure or a retryable status; 0 disables retry. */
  retry: number;
  /** Max upstream requests in flight at once; 0 or unset (the default) disables the local queue. */
  maxConcurrency?: number;
}

/** Validate the `--effort`/`AGENTX_EFFORT` value against the union of both clients' scales. */
export function configuredEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined || value === "") return undefined;
  const allowed = [...new Set<string>([...CODEX_EFFORT_LEVELS, ...CLAUDE_EFFORT_LEVELS])];
  if (allowed.includes(value)) return value as ReasoningEffort;
  throw new Error(`Invalid effort "${value}" (expected one of ${allowed.join(", ")})`);
}

/**
 * Parse `--key value` CLI flags into a plain map.
 * - `--key=value` and `--key value` are equivalent
 * - a flag followed by another flag (or end of input) is boolean-ish and maps to "true",
 *   so `--verbose --model m` keeps both flags intact
 */
export function parseCliOptions(args: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key?.startsWith("--")) continue;
    const [name, inline] = key.slice(2).split("=", 2);
    if (inline !== undefined) { out[name] = inline; continue; }
    const value = args[i + 1];
    out[name] = value === undefined || value.startsWith("--") ? "true" : (i++, value);
  }
  return out;
}

/**
 * Collect every `--header` occurrence into one map. The flag is repeatable,
 * which `parseCliOptions`' last-wins map cannot express, so this reads the raw
 * argument list instead. Both `--header k=v` and `--header=k:v` are accepted,
 * and the value keeps any later `=` / `:` characters (URLs are common values).
 */
export function parseHeaderFlags(args: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const match = /^\s*([^=:]+?)\s*[=:]\s*(.*)$/.exec(raw);
    if (!match) return;
    headers[match[1]] = match[2];
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--header") { const value = args[i + 1]; if (value !== undefined && !value.startsWith("--")) { add(value); i++; } continue; }
    if (arg?.startsWith("--header=")) add(arg.slice("--header=".length));
  }
  return headers;
}

interface RememberedModel {
  provider?: string;
  model?: string;
}

/**
 * Resolve the effective model. A deprecated `auto` value falls back to the
 * provider default rather than breaking an old shell profile; new interfaces
 * no longer advertise implicit routing.
 */
function configuredModel(value: string | undefined, remembered: string | undefined, provider: string | undefined): string {
  const explicit = value === "auto" ? undefined : value;
  return explicit ?? remembered ?? defaultModelFor(provider ?? "opencode");
}

export function loadConfig(
  options: Record<string, string | undefined> = {},
  remembered: RememberedModel = {},
): Config {
  const apiKey = options.apiKey ?? options["api-key"] ?? "";
  const provider = options.provider ?? process.env.AGENTX_PROVIDER;
  const port = Number(options.port ?? process.env.AGENTX_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const retry = Number(options.retry ?? process.env.AGENTX_RETRY ?? 3);
  if (!Number.isInteger(retry) || retry < 0) throw new Error("Invalid retry count");
  const maxConcurrency = Number(options["max-concurrency"] ?? options.maxConcurrency ?? process.env.AGENTX_MAX_CONCURRENCY ?? 0);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 0) throw new Error("Invalid max concurrency");
  const envModel = process.env.AGENTX_MODEL === "auto" ? undefined : process.env.AGENTX_MODEL;
  const rememberedModel = remembered.provider && provider && remembered.provider !== provider
    ? undefined
    : remembered.model;
  return {
    host: options.host ?? process.env.AGENTX_HOST ?? "127.0.0.1",
    port,
    model: configuredModel(options.model ?? envModel, rememberedModel, provider),
    provider,
    backgroundModel: options["background-model"] ?? process.env.AGENTX_BACKGROUND_MODEL,
    effort: configuredEffort(options.effort ?? process.env.AGENTX_EFFORT),
    apiKey,
    logLevel: options.verbose ? "debug" : process.env.AGENTX_LOG_LEVEL ?? "info",
    retry,
    maxConcurrency,
  };
}
