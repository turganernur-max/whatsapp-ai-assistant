// USD per 1M tokens. Approximate list prices; used for the spend tracker and the monthly cap.
// Cache writes are billed at 1.25x input (5-minute cache).
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};
const FALLBACK_PRICE = { input: 8, output: 40, cacheRead: 0.8 }; // conservative for unknown models

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function priceFor(model: string) {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(k + "-"));
  return key ? PRICES[key] : FALLBACK_PRICE;
}

export function costUsd(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      cacheRead * p.cacheRead +
      cacheWrite * p.input * 1.25) /
    1_000_000
  );
}

// Speech-to-text: approx. price per audio second (whisper-large-v3 class models ≈ $0.11–0.36/hour).
export const STT_USD_PER_SECOND = 0.36 / 3600;
