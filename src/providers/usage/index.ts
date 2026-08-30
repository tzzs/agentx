import type { ProviderModel } from "../types.js";
import type { TokenUsage, UsageContext } from "../../usage/types.js";
import { extractResponsesUsage, extractChatUsage, mapResponsesUsage, mapChatUsage } from "./openai.js";
import { extractAnthropicUsage, mapAnthropicUsage } from "./anthropic.js";

export type { TokenUsage, UsageContext } from "../../usage/types.js";
// Bare-usage-object field mappers, re-exported so src/streaming/common.ts can
// derive cache/reasoning tokens from a raw usage chunk without keeping its
// own copy of these field names.
export { mapResponsesUsage, mapChatUsage, mapAnthropicUsage };

export function extractUsage(response: any, model: ProviderModel, ctx: UsageContext): TokenUsage | null {
  const context = { ...ctx, provider: model.provider, model: model.model };
  switch (model.protocol) {
    case "responses": return extractResponsesUsage(response, context);
    case "chat-completions": return extractChatUsage(response, context);
    case "anthropic": return extractAnthropicUsage(response, context);
  }
}
