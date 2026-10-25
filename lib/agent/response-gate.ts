import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { experimental_decide as jevDecide } from "ai";
import { config } from "../config.ts";
import { PRIMARY_MODEL, generateSimple, system, user } from "../llm/index.ts";
import { logger } from "../log.ts";

const log = logger("ResponseGate");

export const REACTION_EMOJIS = [
  "thumbsup",
  "joy",
  "thinking_face",
  "fire",
  "heart",
  "smiling_face_with_3_hearts",
  "white_check_mark",
  "eyes",
  "tada",
];

const SYSTEM_MESSAGE = `You decide how an AI assistant present in a Slack thread should handle a
new message. Choose exactly one:

- "respond" - reply with a full text message. When the message is
  directed at the assistant, asks it something it can answer, or the
  conversation clearly calls for it to contribute. The assistant appears
  in the transcript as "Manfrod". Treat these as directed at it:
  - it is addressed by name ("Manfrod, ..."), even without an @mention
  - the message corrects, disputes or adds to something Manfrod just said
    (e.g. Manfrod wrote "z Escape" and the reply is just "z Scape")
  - someone complains Manfrod did not answer or tells it to answer
    ("to odpowiedz", "halo?", "zghostowałeś mnie", "?")
  - a follow-up question right after Manfrod's own reply that only makes
    sense as a question to Manfrod
- "react:<emoji>" - add ONLY an emoji reaction, no text. Use this fairly
  often — whenever a lightweight nod fits better than a full reply or
  staying silent, e.g. a message is funny, impressive, a clear
  success/completion, or otherwise worth a small acknowledgement.
- "react_and_respond:<emoji>" - add an emoji reaction AND reply with a
  full text message. Use this when the message both calls for a real
  reply and clearly deserves an emoji on top — most notably when someone
  says something nice, complimentary, or appreciative about the
  assistant itself: react with a warm emoji like "heart" or
  "smiling_face_with_3_hearts" and also reply.
- "ignore" - do nothing. The right choice for ordinary back-and-forth
  between people that isn't directed at or about the assistant and
  doesn't call for any acknowledgement. When in doubt whether a message
  is meant for the assistant, do not choose "ignore": a missed question
  is far worse than an unneeded reply.

One case overrides all of the above: if the message asks the assistant to
stop replying in this thread, to leave, or to butt out (e.g. "przestań się
tu udzielać", "zostaw nas", "nie odzywaj się więcej w tym wątku", "stop
replying here"), always choose "respond" — never react or ignore. Acting
on that request is something only a full turn can do, so a silent nod
would quietly refuse it.

For "react:<emoji>" and "react_and_respond:<emoji>", <emoji> must be
exactly one of: ${REACTION_EMOJIS.join(", ")}.

Respond with exactly one line: "respond", "react:<emoji>",
"react_and_respond:<emoji>", or "ignore".
`;

export type GateDecision =
  { kind: "respond" } | { kind: "react"; emoji: string } | { kind: "react_and_respond"; emoji: string } | { kind: "ignore" };

const LINE_LIMIT = 800;

function tail(line: string): string {
  return line.length > LINE_LIMIT ? `…${line.slice(-LINE_LIMIT)}` : line;
}

function normalizeEmoji(rest: string): string | null {
  const emoji = rest.trim().replace(/^:+|:+$/g, "");
  return REACTION_EMOJIS.includes(emoji) ? emoji : null;
}

export function parseDecision(response: unknown): GateDecision {
  if (typeof response !== "string") return { kind: "respond" };
  const value = response.trim().toLowerCase();
  if (value.startsWith("respond")) return { kind: "respond" };
  if (value.startsWith("react_and_respond:")) {
    const emoji = normalizeEmoji(value.slice("react_and_respond:".length));
    return emoji ? { kind: "react_and_respond", emoji } : { kind: "respond" };
  }
  if (value.startsWith("react:")) {
    const emoji = normalizeEmoji(value.slice("react:".length));
    return emoji ? { kind: "react", emoji } : { kind: "ignore" };
  }
  if (value.startsWith("ignore")) return { kind: "ignore" };
  return { kind: "respond" };
}

const ACTION_CRITERIA = {
  respond:
    "Reply with a full text message: the message is directed at the assistant (addressed as Manfrod even without an @mention, corrects or adds to what Manfrod just said, complains Manfrod did not answer, or is a follow-up only Manfrod can answer), asks it something it can answer, or asks it to stop replying in or leave this thread.",
  react:
    "Add only an emoji reaction, no text: a lightweight nod fits better than a reply or silence, e.g. the message is funny, impressive, a clear success or completion, or otherwise worth a small acknowledgement.",
  react_and_respond:
    "Add an emoji reaction and also reply in full: the message calls for a real reply and clearly deserves an emoji on top, most notably someone saying something nice, complimentary or appreciative about the assistant itself.",
  ignore:
    "Do nothing: ordinary back-and-forth between people that is not directed at or about the assistant and calls for no acknowledgement. Never when in doubt whether the message is meant for the assistant.",
};

const EMOJI_CRITERIA = {
  thumbsup: "Agreement, approval or a simple acknowledgement",
  joy: "Something funny",
  thinking_face: "Something puzzling or worth pondering",
  fire: "Something impressive or exciting",
  heart: "Warmth or appreciation, especially toward the assistant",
  smiling_face_with_3_hearts: "A compliment or kind words about the assistant",
  white_check_mark: "A task done, a success or a completion",
  eyes: "Something interesting to keep an eye on",
  tada: "A celebration, launch or milestone",
};

async function decideWithJev(history: string, incoming: string): Promise<GateDecision> {
  const result = await jevDecide({
    model: typeSafeAi.decisionModel(config.decisionModel),
    state: { recent_conversation: history, new_messages: incoming },
    questions: {
      action: { type: "choice", instructions: SYSTEM_MESSAGE, criteria: ACTION_CRITERIA },
      emoji: {
        type: "choice",
        instructions: "If the assistant adds a reaction to the new message(s), which emoji fits best?",
        criteria: EMOJI_CRITERIA,
      },
    },
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(8_000),
  });
  const action = result.answers.action.choice;
  const emoji = result.answers.emoji.choice;
  if (action === "react") return { kind: "react", emoji };
  if (action === "react_and_respond") return { kind: "react_and_respond", emoji };
  return { kind: action };
}

async function decideWithLlm(history: string, incoming: string): Promise<GateDecision> {
  const prompt = `Recent conversation:\n${history}\n\nNew message(s):\n${incoming}\n\nWhat should the assistant do?\n`;
  const response = await generateSimple(PRIMARY_MODEL, [system(SYSTEM_MESSAGE), user(prompt)], {
    purpose: "response_gate",
    timeoutMs: 8_000,
  });
  return parseDecision(response);
}

export async function decide(recentTranscript: string[], newMessages: string[]): Promise<GateDecision> {
  const history = recentTranscript.length === 0 ? "(none)" : recentTranscript.map(tail).join("\n");
  const incoming = newMessages.map(tail).join("\n");
  if (config.typesafeApiKey) {
    try {
      return await decideWithJev(history, incoming);
    } catch (error) {
      log.debug(`ResponseGate: decision model error, falling back to LLM: ${(error as Error).message}`);
    }
  }
  try {
    return await decideWithLlm(history, incoming);
  } catch (error) {
    log.debug(`ResponseGate: LLM error, defaulting to respond: ${(error as Error).message}`);
    return { kind: "respond" };
  }
}
