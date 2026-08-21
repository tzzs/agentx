export type ProviderProtocol = "responses" | "chat-completions";

export interface ProviderCapabilities {
  supportsUsage: boolean;
  supportsStreamingUsage: boolean;
  supportsCacheTokens: boolean;
}

export interface ProviderModel {
  provider: string;
  model: string;
  protocol: ProviderProtocol;
  endpoint: string;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  apiKeyEnv: string;
  capabilities?: ProviderCapabilities;
  models: ProviderModel[];
}
