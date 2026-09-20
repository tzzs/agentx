import type { ProviderModel } from "../types.js";
import type { TokenUsage, UsageContext } from "../../usage/types.js";
import type { JsonRecord } from "../../json.js";
import { extractResponsesUsage, extractChatUsage, mapResponsesUsage, mapChatUsage } from "./openai.js";
import { extractAnthropicUsage, mapAnthropicUsage } from "./anthropic.js";

export type { TokenUsage, UsageContext } from "../../usage/types.js";
// Bare-usage-object field mappers, re-exported so the streaming pipes in
// src/streaming/common.ts can read token fields from raw usage chunks through
// the same field lists as the non-streaming path.
export { mapResponsesUsage, mapChatUsage, mapAnthropicUsage };

export function extractUsage(response: JsonRecord, model: ProviderModel, ctx: UsageContext): TokenUsage | null {
  const context = { ...ctx, provider: model.provider, model: model.model };
  switch (model.protocol) {
    case "responses": return extractResponsesUsage(response, context);
    case "chat-completions": return extractChatUsage(response, context);
    case "anthropic": return extractAnthropicUsage(response, context);
  }
}
