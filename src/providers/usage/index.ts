import type { ProviderModel } from "../types.js";
import type { TokenUsage, UsageContext } from "../../usage/types.js";
import { extractResponsesUsage, extractChatUsage } from "./openai.js";
import { extractAnthropicUsage } from "./anthropic.js";

export type { TokenUsage, UsageContext } from "../../usage/types.js";

export function extractUsage(response: any, model: ProviderModel, ctx: UsageContext): TokenUsage | null {
  const context = { ...ctx, provider: model.provider, model: model.model };
  switch (model.protocol) {
    case "responses": return extractResponsesUsage(response, context);
    case "chat-completions": return extractChatUsage(response, context);
    case "anthropic": return extractAnthropicUsage(response, context);
  }
}
