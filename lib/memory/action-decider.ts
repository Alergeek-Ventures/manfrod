import { readFileSync } from "node:fs";
import path from "node:path";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { experimental_decide as decide } from "ai";
import { config } from "../config.ts";
import { logger } from "../log.ts";

export const MEMORY_ACTIONS = ["ignore", "create_memory", "create_absence", "create_meeting", "flag_sensitive", "ask_human"] as const;
export type MemoryAction = (typeof MEMORY_ACTIONS)[number];

export interface ActionInput {
  text: string;
  author: string;
  channelKind: string;
  channelType: string;
  resolvedScope: string;
}

export interface ActionDecision {
  action: MemoryAction;
  probability: number | null;
}

const log = logger("MemoryActionDecider");
const TIMEOUT_MS = 8_000;
const SUBSTANTIVE_THRESHOLD = 0.2;

const SECTION_ACTIONS: Record<string, MemoryAction> = {
  IGNORE: "ignore",
  SAFETY: "ignore",
  CREATE_ABSENCE: "create_absence",
  CREATE_MEETING: "create_meeting",
  CREATE_MEMORY: "create_memory",
  FLAG_SENSITIVE: "flag_sensitive",
  ASK_HUMAN: "ask_human",
  'Widening a DM to "internal"': "ask_human",
  "Widening to a client": "ask_human",
};

let cached: { instructions: string; criteria: Record<MemoryAction, string> } | null = null;

export function classifierRules() {
  if (cached) return cached;
  const prompt = readFileSync(path.join(process.cwd(), "lib", "prompts", "classifier.md"), "utf8");
  const lines = prompt.split("\n");
  const intro = lines.slice(0, lines.findIndex((line) => line.startsWith("Possible actions"))).join("\n").trim();
  const criteria = Object.fromEntries(MEMORY_ACTIONS.map((action) => [action, ""])) as Record<MemoryAction, string>;
  let current: MemoryAction | null = null;
  for (const line of lines) {
    const header = /^── (.+?) ─*$/.exec(line);
    if (header) {
      current = SECTION_ACTIONS[header[1].trim()] ?? null;
      continue;
    }
    if (current) criteria[current] += `${line}\n`;
  }
  cached = {
    instructions: `${intro}\n\nPick exactly one action for the message in the state.`,
    criteria: Object.fromEntries(Object.entries(criteria).map(([action, text]) => [action, text.trim()])) as Record<MemoryAction, string>,
  };
  return cached;
}

export const jevEnabled = () => Boolean(config.typesafeApiKey);

export async function decideAction(input: ActionInput, today: string): Promise<ActionDecision | null> {
  if (!jevEnabled()) return null;
  const rules = classifierRules();
  try {
    const result = await decide({
      model: typeSafeAi.decisionModel(config.decisionModel),
      state: {
        current_date: today,
        channel: input.channelKind,
        channel_type: input.channelType,
        resolved_scope: input.resolvedScope,
        author: input.author,
        message: input.text,
      },
      questions: { action: { type: "choice", instructions: rules.instructions, criteria: rules.criteria } },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = result.answers.action;
    const action = answer.choice as MemoryAction;
    return { action, probability: answer.probabilities?.[action] ?? null };
  } catch (error) {
    log.warn(`MemoryActionDecider: Jev failed, falling back to the LLM: ${(error as Error).message}`);
    return null;
  }
}

export async function worthSummarizing(conversation: string): Promise<boolean | null> {
  if (!jevEnabled()) return null;
  try {
    const result = await decide({
      model: typeSafeAi.decisionModel(config.decisionModel),
      state: { conversation },
      questions: {
        substantive: {
          type: "boolean",
          instructions:
            "Does this conversation between a person and the assistant contain anything worth a written summary: a question that got a real answer, a decision, a fact, a task, a plan or a follow-up? Greetings, thanks, small talk and one-word replies alone are not.",
        },
      },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return result.answers.substantive.probability >= SUBSTANTIVE_THRESHOLD;
  } catch (error) {
    log.warn(`MemoryActionDecider: Jev summary check failed, summarizing anyway: ${(error as Error).message}`);
    return null;
  }
}

export const NO_PROJECT = "none";

export async function suggestProject(
  channel: { name: string; purpose: string; topic: string },
  projects: { slug: string; name: string }[],
): Promise<string | null> {
  if (!jevEnabled() || projects.length === 0) return null;
  const criteria: Record<string, string> = {
    [NO_PROJECT]: "The channel is not about one specific project: company-wide, social, tooling, announcements or anything else.",
    ...Object.fromEntries(projects.map((project) => [project.slug, `Work on the project "${project.name}" (slug ${project.slug}).`])),
  };
  try {
    const result = await decide({
      model: typeSafeAi.decisionModel(config.decisionModel),
      state: channel,
      questions: {
        project: {
          type: "choice",
          instructions: "Which project, if any, is this Slack channel dedicated to? Only pick a project when the channel clearly belongs to it.",
          criteria,
        },
      },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const choice = result.answers.project.choice;
    return choice === NO_PROJECT ? null : choice;
  } catch (error) {
    log.warn(`MemoryActionDecider: Jev project suggestion failed: ${(error as Error).message}`);
    return null;
  }
}
