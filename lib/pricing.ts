export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  cached_input_per_mtok: number;
  cache_write_per_mtok: number;
  cache_write_above_per_mtok: number | null;
  cache_write_threshold: number | null;
  label: string;
  free: boolean;
}

const UNKNOWN_MODEL_PRICE: ModelPrice = {
  input_per_mtok: 0,
  output_per_mtok: 0,
  cached_input_per_mtok: 0,
  cache_write_per_mtok: 0,
  cache_write_above_per_mtok: null,
  cache_write_threshold: null,
  label: "unknown",
  free: true,
};

const PRICES: Record<string, ModelPrice> = {
  "openai/gpt-5.6-luna": {
    input_per_mtok: 0.2,
    output_per_mtok: 1.2,
    cached_input_per_mtok: 0.01,
    cache_write_per_mtok: 0.125,
    cache_write_above_per_mtok: 0.25,
    cache_write_threshold: 272_000,
    label: "GPT-5.6 Luna",
    free: false,
  },
  "anthropic/claude-opus-5.5": {
    input_per_mtok: 4,
    output_per_mtok: 20,
    cached_input_per_mtok: 0.2,
    cache_write_per_mtok: 5,
    cache_write_above_per_mtok: null,
    cache_write_threshold: null,
    label: "Claude Opus 5.5",
    free: false,
  },
  "anthropic/claude-sonnet-5.5": {
    input_per_mtok: 2,
    output_per_mtok: 10,
    cached_input_per_mtok: 0.1,
    cache_write_per_mtok: 2.5,
    cache_write_above_per_mtok: null,
    cache_write_threshold: null,
    label: "Claude Sonnet 5.5",
    free: false,
  },
  "anthropic/claude-haiku-5.5": {
    input_per_mtok: 0.1,
    output_per_mtok: 0.5,
    cached_input_per_mtok: 0.01,
    cache_write_per_mtok: 0.125,
    cache_write_above_per_mtok: null,
    cache_write_threshold: null,
    label: "Claude Haiku 5.5",
    free: false,
  },
  "deepseek/deepseek-v4-flash": {
    input_per_mtok: 0.0882,
    output_per_mtok: 0.1764,
    cached_input_per_mtok: 0.01764,
    cache_write_per_mtok: 0,
    cache_write_above_per_mtok: null,
    cache_write_threshold: null,
    label: "DeepSeek V4 Flash",
    free: false,
  },
  "moonshotai/kimi-k2.5": {
    input_per_mtok: 0.6,
    output_per_mtok: 3,
    cached_input_per_mtok: 0.1,
    cache_write_per_mtok: 0,
    cache_write_above_per_mtok: null,
    cache_write_threshold: null,
    label: "Kimi K2.5",
    free: false,
  },
  "llama-3.1-8b-instant": {
    input_per_mtok: 0,
    output_per_mtok: 0,
    cached_input_per_mtok: 0,
    cache_write_per_mtok: 0,
    cache_write_above_per_mtok: null,
    cache_write_threshold: null,
    label: "Llama 3.1 8B Instant",
    free: true,
  },
};

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  cache_creation_tokens?: number | null;
}

export function pricingTable(): Record<string, ModelPrice> {
  return PRICES;
}

export function forModel(model: string | null | undefined): ModelPrice {
  return (model && PRICES[model]) || UNKNOWN_MODEL_PRICE;
}

export function label(model: string | null | undefined): string {
  if (!model) return "unknown";
  return PRICES[model]?.label ?? model;
}

export function isFree(model: string | null | undefined): boolean {
  return forModel(model).free;
}

export function isKnown(model: string | null | undefined): boolean {
  return typeof model === "string" && model in PRICES;
}

const count = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return 0;
};

const perMtok = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;

function cacheWriteCost(tokens: number, price: ModelPrice): number {
  if (tokens === 0) return 0;
  if (
    price.cache_write_above_per_mtok !== null &&
    price.cache_write_threshold !== null &&
    tokens > price.cache_write_threshold
  ) {
    return perMtok(tokens, price.cache_write_above_per_mtok);
  }
  return perMtok(tokens, price.cache_write_per_mtok);
}

export function cost(model: string | null | undefined, usage: TokenUsage): number {
  const price = forModel(model);
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cached = count(usage.cached_tokens);
  const cacheWrite = count(usage.cache_creation_tokens);
  const freshInput = Math.max(input - cached, 0);

  return (
    perMtok(freshInput, price.input_per_mtok) +
    perMtok(cached, price.cached_input_per_mtok) +
    perMtok(output, price.output_per_mtok) +
    cacheWriteCost(cacheWrite, price)
  );
}

export function uncachedCost(model: string | null | undefined, usage: TokenUsage): number {
  const price = forModel(model);
  return (
    perMtok(count(usage.input_tokens), price.input_per_mtok) +
    perMtok(count(usage.output_tokens), price.output_per_mtok)
  );
}
