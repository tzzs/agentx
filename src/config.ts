import { loadLastProfile } from "./profiles.js";
import { defaultModelFor } from "./selection.js";

export interface Config {
  host: string;
  port: number;
  model: string;
  provider?: string;
  apiKey: string;
  logLevel: string;
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

export function loadConfig(options: Record<string, string | undefined> = {}): Config {
  const apiKey = options.apiKey ?? options["api-key"] ?? "";
  const provider = options.provider ?? process.env.AGENTX_PROVIDER;
  const defaultModel = provider ? defaultModelFor(provider) : "gpt-5.6-luna";
  const port = Number(options.port ?? process.env.AGENTX_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  const remembered = loadLastProfile();
  const rememberedModel = remembered && (!provider || remembered.provider === provider) ? remembered.model : undefined;
  return {
    host: options.host ?? process.env.AGENTX_HOST ?? "127.0.0.1",
    port,
    model: options.model ?? process.env.AGENTX_MODEL ?? rememberedModel ?? defaultModel,
    provider,
    apiKey,
    logLevel: options.verbose ? "debug" : process.env.AGENTX_LOG_LEVEL ?? "info"
  };
}
