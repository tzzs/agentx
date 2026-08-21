import type { PricingProvider } from "../types.js";
import { makePricingProvider } from "./rates.js";

export const googlePricing: PricingProvider = makePricingProvider(
  { inputPerMillion: 1.25, outputPerMillion: 5, cachedInputPerMillion: 0.1 },
  {}
);