import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "../config.ts";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

export const jevEnabled = () => Boolean(config.openrouterApiKey);

export const jevModel = () =>
  createTypeSafeAi({ baseURL: OPENROUTER_API_URL, apiKey: config.openrouterApiKey }).decisionModel(config.decisionModel);
