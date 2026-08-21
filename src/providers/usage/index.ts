import type { ProviderModel } from "../types.js";
import type { ProviderUsageAdapter, TokenUsage, UsageContext } from "../../usage/types.js";
import { extractResponsesUsage, extractChatUsage } from "./openai.js";
import { extractAnthropicUsage } from "./anthropic.js";
import { extractGeminiUsage } from "./google.js";

export type { ProviderUsageAdapter, TokenUsage, UsageContext } from "../../usage/types.js";

export type UsageFormat = "responses" | "chat-completions" | "anthropic" | "gemini";

export function usageFormatFor(model: ProviderModel): UsageFormat {
  if (model.provider === "anthropic") return "anthropic";
  if (model.provider === "google") return "gemini";
  return model.protocol;
}

export function extractUsage(response: any, model: ProviderModel, ctx: UsageContext): TokenUsage | null {
  const format = usageFormatFor(model);
  const provider = model.provider;
  const context = { ...ctx, provider, model: model.model };
  switch (format) {
    case "anthropic": return extractAnthropicUsage(response, context);
    case "gemini": return extractGeminiUsage(response, context);
    case "responses": return extractResponsesUsage(response, context);
    case "chat-completions": return extractChatUsage(response, context);
  }
}

/** Adapter interface bound to a specific model for callers that prefer it. */
export function usageAdapterFor(model: ProviderModel): ProviderUsageAdapter {
  return { extractUsage: (response: any) => extractUsage(response, model, {}) };
}