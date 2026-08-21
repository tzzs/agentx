import type { PricingProvider } from "../types.js";
import { makePricingProvider } from "./rates.js";

export const openAIPricing: PricingProvider = makePricingProvider(
  { inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 0.5 },
  {
    "gpt-5.6-luna": { inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 0.5 },
    "gpt-4o": { inputPerMillion: 5, outputPerMillion: 15, cachedInputPerMillion: 2.5 }
  }
);
