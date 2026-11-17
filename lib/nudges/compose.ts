import { z } from "zod";
import type { User } from "../db/schema.ts";
import { AGENT_MODEL, FALLBACK_CHAIN, generateText, system, user } from "../llm/index.ts";
import { internalLanguage } from "../agent-settings.ts";
import { deliverProactive } from "../proactive.ts";
import { logger } from "../log.ts";
import { localIsoWithOffset } from "../time.ts";
import { NUDGE_KINDS, recordDelivery, type NudgeKind } from "./store.ts";
import { routineText } from "../routines.ts";

const log = logger("Nudges.Compose");

const CHAIN = [{ provider: "openrouter" as const, model: AGENT_MODEL, tier: "paid" as const }, ...FALLBACK_CHAIN];

const DECISION_FORMAT = `Respond with only a JSON object: {"send": true | false, "reason": "<one English sentence>", "message": "<the message>" | null}`;

const decisionSchema = z.object({
  send: z.boolean(),
  reason: z.string().max(1000).default(""),
  message: z.string().max(4000).nullish(),
});

export type Decision = { send: true; reason: string; message: string } | { send: false; reason: string };

const CONTROL_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function escapeControlCharsInStrings(json: string): string {
  let inString = false;
  let escaped = false;
  let out = "";
  for (const char of json) {
    if (inString && !escaped && CONTROL_ESCAPES[char]) {
      out += CONTROL_ESCAPES[char];
      continue;
    }
    if (char === '"' && !escaped) inString = !inString;
    escaped = inString && char === "\\" && !escaped;
    out += char;
  }
  return out;
}

function parseJson(text: string): unknown {
  for (const candidate of [text, escapeControlCharsInStrings(text)]) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return undefined;
}

export function parseDecision(raw: string): Decision | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  const value = parseJson(raw.slice(start, end + 1));
  if (value === undefined) return null;
  const parsed = decisionSchema.safeParse(value);
  if (!parsed.success) return null;
  const { send, reason, message } = parsed.data;
  if (send && message?.trim()) return { send, reason, message: message.trim() };
  return { send: false, reason };
}

export interface Nudge {
  kind: NudgeKind;
  period: string;
  person: User;
  guidance: string;
  context: string;
  followUp: string;
}

export interface Brief {
  kind: string;
  audience: string;
  guidance: string;
  context: string;
  language?: string;
  userId?: string;
}

export async function decide(brief: Brief): Promise<Decision | null> {
  const text = `Kind: ${brief.kind}
Language: ${brief.language ?? (await internalLanguage())}
Guidance: ${brief.guidance}
Now: ${localIsoWithOffset(new Date())}
Readers: ${brief.audience}

<data>
${brief.context}
</data>`;
  const result = await generateText([system(`${routineText("proactive-style")}\n\n${DECISION_FORMAT}`), user(text)], {
    purpose: "nudge",
    chain: CHAIN,
    userId: brief.userId ?? null,
  });
  const decision = parseDecision(result.text);
  if (!decision) log.warn(`Nudges.Compose: could not parse the ${brief.kind} decision: ${result.text.slice(0, 1500)}`);
  return decision;
}

function agentPrompt(nudge: Nudge, message: string): string {
  return `[Proaktywnie: ${NUDGE_KINDS[nudge.kind]}]
Piszesz do tej osoby z własnej inicjatywy. Wyślij jej wiadomość, którą już przygotowałeś. Możesz wygładzić styl, ale nie dodawaj faktów spoza danych poniżej i nie wołaj teraz narzędzi:

<message>
${message}
</message>

Dane, na których się oparłeś, do dalszej rozmowy:
<data>
${nudge.context}
</data>

${nudge.followUp}
Jeśli ta osoba napisze, że nie chce takich wiadomości albo że znowu chce, wywołaj set-proactive-preferences z kind "${nudge.kind}".`;
}

export async function run(nudge: Nudge): Promise<boolean> {
  const decision = await decide({
    kind: NUDGE_KINDS[nudge.kind],
    audience: `a DM to ${nudge.person.name ?? nudge.person.email} (<@${nudge.person.slackId}>)`,
    guidance: nudge.guidance,
    context: nudge.context,
    userId: nudge.person.id,
  });
  if (!decision) {
    await recordDelivery(nudge.person.id, nudge.kind, nudge.period, false, "The decision could not be parsed.");
    return false;
  }
  if (!decision.send) {
    await recordDelivery(nudge.person.id, nudge.kind, nudge.period, false, decision.reason);
    return false;
  }
  const sent = await deliverProactive(nudge.person.id, agentPrompt(nudge, decision.message), `nudge_${nudge.kind}`, decision.message);
  if (!sent.ok) return false;
  await recordDelivery(nudge.person.id, nudge.kind, nudge.period, true, decision.reason);
  return true;
}
