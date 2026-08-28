export type ProviderProtocol = "responses" | "chat-completions" | "anthropic";

export interface ProviderModel {
  provider: string;
  model: string;
  protocol: ProviderProtocol;
  endpoint: string;
  /** Real limits from the upstream registry when known; consumers fall back to safe defaults. */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Input modalities the upstream accepts, restricted to what clients understand ("text", "image"). */
  modalities?: string[];
}

export interface ProviderDefinition {
  id: string;
  name: string;
  apiKeyEnv: string;
  models: ProviderModel[];
  /** True for a provider registered at runtime (custom OpenAI/Anthropic-compatible endpoint) rather than built into the registry. */
  custom?: boolean;
}
