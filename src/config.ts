export interface Config {
  host: string;
  port: number;
  model: string;
  apiKey: string;
  logLevel: string;
}

export function loadConfig(options: Record<string, string | undefined> = {}): Config {
  const apiKey = options.apiKey ?? process.env.OPENCODE_GO_API_KEY ?? "";
  const port = Number(options.port ?? process.env.OPENCODE_ADAPTER_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  return {
    host: options.host ?? process.env.OPENCODE_ADAPTER_HOST ?? "127.0.0.1",
    port,
    model: options.model ?? process.env.OPENCODE_ADAPTER_MODEL ?? "gpt-5.6-luna",
    apiKey,
    logLevel: process.env.OPENCODE_ADAPTER_LOG_LEVEL ?? "info"
  };
}
