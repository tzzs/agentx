export interface Config {
  host: string;
  port: number;
  model: string;
  provider?: string;
  apiKey: string;
  logLevel: string;
}

export function loadConfig(options: Record<string, string | undefined> = {}): Config {
  const apiKey = options.apiKey ?? options["api-key"] ?? "";
  const provider = options.provider ?? process.env.AGENTX_PROVIDER;
  const defaultModel = provider === "deepseek" ? "deepseek-v4-pro" : provider === "openrouter" ? process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini" : "gpt-5.6-luna";
  const port = Number(options.port ?? process.env.AGENTX_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  return {
    host: options.host ?? process.env.AGENTX_HOST ?? "127.0.0.1",
    port,
    model: options.model ?? process.env.AGENTX_MODEL ?? defaultModel,
    provider,
    apiKey,
    logLevel: process.env.AGENTX_LOG_LEVEL ?? "info"
  };
}
