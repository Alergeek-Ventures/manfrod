import type { LanguageModelMiddleware } from "ai";

type Options = Record<string, Record<string, unknown>> | undefined;

const CACHE_KEYS = ["cacheControl", "cache_control"];
const PROVIDERS = ["anthropic", "openrouter"];

function cacheMarker(options: Options): Options {
  for (const provider of PROVIDERS) {
    const entry = options?.[provider];
    if (entry && CACHE_KEYS.some((key) => key in entry)) return { [provider]: entry };
  }
  return undefined;
}

function withoutCacheMarker(options: Options): Options {
  if (!options) return options;
  const result: Record<string, Record<string, unknown>> = {};
  for (const [provider, entry] of Object.entries(options)) {
    if (!PROVIDERS.includes(provider)) {
      result[provider] = entry;
      continue;
    }
    const rest = Object.fromEntries(Object.entries(entry).filter(([key]) => !CACHE_KEYS.includes(key)));
    if (Object.keys(rest).length > 0) result[provider] = rest;
  }
  return result;
}

export const singleToolResultBreakpoint: LanguageModelMiddleware = {
  async transformParams({ params }) {
    const prompt = params.prompt.map((message) => {
      if (message.role !== "tool" || message.content.length < 2) return message;
      const marker = cacheMarker(message.providerOptions as Options);
      if (!marker) return message;
      const last = message.content.findLastIndex((part) => part.type === "tool-result");
      return {
        ...message,
        providerOptions: withoutCacheMarker(message.providerOptions as Options),
        content: message.content.map((part, index) =>
          index === last ? { ...part, providerOptions: { ...part.providerOptions, ...marker } } : part,
        ),
      } as typeof message;
    });
    return { ...params, prompt };
  },
};
