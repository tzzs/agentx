import type { ProviderDefinition, ProviderModel } from "./types.js";

const openCodeBase = "https://opencode.ai/zen/go/v1";
const deepSeekBase = "https://api.deepseek.com/v1";
const openRouterBase = "https://openrouter.ai/api/v1";
const chatModels = ["deepseek-v4-pro", "deepseek-v4-flash", "minimax-m3", "minimax-m2.7", "minimax-m2.5", "kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "glm-5.2", "glm-5.3", "glm-5.1", "glm-5", "mimo-v2.5-pro", "mimo-v2.5", "hy3"];

function models(provider: string, endpoint: string, ids: string[], protocol: "responses" | "chat-completions") { return ids.map((model) => ({ provider, model, protocol, endpoint })); }

export const providerRegistry: ProviderDefinition[] = [
  { id: "opencode", name: "OpenCode Go", apiKeyEnv: "OPENCODE_GO_API_KEY", models: [{ provider: "opencode", model: "gpt-5.6-luna", protocol: "responses", endpoint: `${openCodeBase}/responses` }, ...models("opencode", `${openCodeBase}/chat/completions`, chatModels, "chat-completions")] },
  { id: "deepseek", name: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", models: models("deepseek", `${deepSeekBase}/chat/completions`, ["deepseek-v4-pro", "deepseek-v4-flash"], "chat-completions") },
  { id: "openrouter", name: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", models: models("openrouter", `${openRouterBase}/chat/completions`, [process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini"], "chat-completions") }
];

export const allModels = providerRegistry.flatMap((provider) => provider.models);

export function providerFor(model: string, providerId?: string): ProviderModel {
  const candidates = providerId ? allModels.filter((item) => item.provider === providerId) : allModels;
  const match = candidates.find((item) => item.model === model) ?? (providerId === "openrouter" ? candidates[0] && { ...candidates[0], model } : undefined);
  if (!match) throw new Error(`Model "${model}" is not available. Available models: ${candidates.map((item) => `${item.provider}/${item.model}`).join(", ")}`);
  return match;
}

export function providerById(id: string) { const provider = providerRegistry.find((item) => item.id === id); if (!provider) throw new Error(`Provider "${id}" is not configured.`); return provider; }
export function apiKeyFor(model: ProviderModel, override?: string) { return override || process.env[providerById(model.provider).apiKeyEnv] || ""; }
