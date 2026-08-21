import type { PricingProvider } from "../types.js";
import { makePricingProvider } from "./rates.js";

export const anthropicPricing: PricingProvider = makePricingProvider(
  { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3, cacheWritePerMillion: 3.75 },
  {
    "claude-sonnet-4": { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3, cacheWritePerMillion: 3.75 }
  }
);