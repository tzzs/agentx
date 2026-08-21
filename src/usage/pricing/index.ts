import type { PricingProvider, TokenUsage } from "../types.js";
import { openAIPricing } from "./openai.js";
import { anthropicPricing } from "./anthropic.js";
import { googlePricing } from "./google.js";

const registry: Record<string, PricingProvider> = {
  openai: openAIPricing,
  opencode: openAIPricing,
  deepseek: openAIPricing,
  anthropic: anthropicPricing,
  google: googlePricing
};

export function pricingFor(provider: string): PricingProvider {
  return registry[provider] ?? openAIPricing;
}

export function calculateCost(provider: string, model: string, usage: TokenUsage): number {
  return pricingFor(provider).calculate(model, usage);
}

export { openAIPricing, anthropicPricing, googlePricing };