import { readFileSync } from "node:fs";
import path from "node:path";
import type { BufferedMessage, Node } from "../db/schema.ts";
import { getUserBySlackId } from "../accounts.ts";
import { broadcast } from "../events/index.ts";
import { addAccess, overlappingAbsences, putAbsence, setFact } from "../facts.ts";
import { generateText, system, user } from "../llm/index.ts";
import { decideAction, type MemoryAction } from "./action-decider.ts";
import { logger } from "../log.ts";
import { ensureValidToken, getConnection } from "../mcp/index.ts";
import { sendProactive } from "../proactive.ts";
import { getBody } from "../skills.ts";
import { post } from "../slack/api.ts";
import { isValidIsoDate, localToday, weekdayName } from "../time.ts";
import { embedQuery } from "../voyage.ts";
import { clientIdForChannel, ensureMembership, getActiveMapping, isPrivate, privateLevel, projectIdForChannel } from "./access.ts";
import { detect, ensureMapping } from "./channel-detector.ts";
import { createLink, createNode, deleteLink, deleteNode, escalateNoteAccess } from "./nodes.ts";
import {
  deleteConfirmation,
  getConfirmation,
  putConfirmation,
  take,
  type ConfirmationPayload,
  type Flag,
  type PendingOp,
} from "./pending.ts";

const log = logger("Classifier");

type Lang = "pl" | "en";
type Result = Record<string, any>;

const LEVELS_BLOCK_ID = "memory_escalation_levels_block";
const LEVELS_ACTION_ID = "memory_escalation_levels";

function systemPrompt(): string {
  return readFileSync(path.join(process.cwd(), "lib", "prompts", "classifier.md"), "utf8");
}

async function findUserId(slackUserId: string | null | undefined): Promise<string | null> {
  return (await getUserBySlackId(slackUserId))?.id ?? null;
}

export async function classifyBatch(messages: BufferedMessage[], channelId: string, channelName: string | null) {
  const writeAccess = await ensureMapping(channelId, channelName);
  const kind = resolveKind(channelId, channelName, writeAccess);
  await ensureAuthorMemberships(messages, channelId);
  await doClassifyBatch(messages, channelId, kind, writeAccess);
}

async function ensureAuthorMemberships(messages: BufferedMessage[], channelId: string) {
  const mapping = await getActiveMapping(channelId);
  if (!mapping?.projectId) return;
  for (const slackUserId of new Set(messages.map((message) => message.user))) {
    const userId = await findUserId(slackUserId);
    if (userId) await ensureMembership(userId, mapping.projectId);
  }
}

function resolveKind(channelId: string, channelName: string | null, writeAccess: string[]): string {
  const detected = detect(channelId, channelName);
  if (detected) return detected.kind;
  return writeAccess.some((level) => level.startsWith("external/")) ? "project_external" : "company_channel";
}

const SETTLED_BY_JEV: ReadonlySet<MemoryAction> = new Set(["ignore", "flag_sensitive"]);

async function jevActions(messages: BufferedMessage[], kind: string, today: string, flagged: boolean[]) {
  return Promise.all(
    messages.map(async (message, index) => {
      if (flagged[index]) return null;
      const decision = await decideAction(
        {
          text: message.text ?? "",
          author: message.user_name ?? message.user ?? "unknown",
          channelKind: kind,
          channelType: CHANNEL_TYPES[kind] ?? "unknown",
          resolvedScope: RESOLVED_SCOPES[kind] ?? "none",
        },
        today,
      );
      return decision && SETTLED_BY_JEV.has(decision.action) ? decision.action : null;
    }),
  );
}

async function llmResults(messages: BufferedMessage[], kind: string, today: string): Promise<Result[] | null> {
  if (messages.length === 0) return [];
  const formatted = messages.map((message, index) => `Message ${index}:\n${formatMessage(message, kind)}`).join("\n---\n");
  const userMessage =
    `Current date: ${today} (${weekdayName(today)}).\n` +
    `Classify each of the following ${messages.length} message(s). ` +
    `Return a JSON array with exactly ${messages.length} objects in the same order.\n\n` +
    formatted;

  let raw: string;
  try {
    raw = (await generateText([system(systemPrompt()), user(userMessage)], { purpose: "classifier" })).text || "[]";
  } catch (error) {
    log.error(`Classifier LLM error: ${(error as Error).message}`);
    return null;
  }
  const parsed = parseBulkResponse(raw);
  if (!parsed.ok) {
    log.warn(`Classifier bulk parse failed: ${parsed.error} / raw: ${raw.slice(0, 200)}`);
    return null;
  }
  return parsed.results;
}

async function doClassifyBatch(messages: BufferedMessage[], channelId: string, kind: string, writeAccess: string[]) {
  const today = localToday();
  const pendings = await Promise.all(messages.map((message) => take(channelId, message.ts)));
  const settled = await jevActions(
    messages,
    kind,
    today,
    pendings.map((pending) => pending.flag !== null),
  );
  const forLlm = messages.map((_, index) => index).filter((index) => settled[index] === null);
  const llm = await llmResults(
    forLlm.map((index) => messages[index]),
    kind,
    today,
  );
  if (forLlm.length > 0) log.info(`Classifier [${channelId}] ${messages.length - forLlm.length}/${messages.length} settled by Jev`);

  for (const [index, message] of messages.entries()) {
    const pending = pendings[index];
    const jevAction = settled[index];
    let decided: Result | null;
    if (jevAction) decided = { action: jevAction, reasoning: "decided by Jev" };
    else decided = llm?.[forLlm.indexOf(index)] ?? null;
    if (!decided) {
      await runOps(pending.ops);
      continue;
    }
    const [action, result] = applyPendingFlag(pending.flag, decided);
    const flagged = pending.flag ? " (agent-flagged)" : "";
    log.info(`Classifier [${channelId}] msg ${index}: ${action}${flagged} — ${result.reasoning ?? ""}`);

    const messageAccess = await messageWriteAccess(channelId, message, writeAccess);
    try {
      await dispatchAction(action, result, message, channelId, kind, messageAccess);
    } catch (error) {
      log.error(`Classifier ${action} failed: ${(error as Error).message}`);
    }
    await runOps(pending.ops);
  }
}

async function messageWriteAccess(channelId: string, message: BufferedMessage, fallback: string[]) {
  if (!channelId.startsWith("D")) return fallback;
  const userId = await findUserId(message.user);
  return userId ? [privateLevel(userId)] : fallback;
}

async function dispatchAction(
  action: string,
  result: Result,
  message: BufferedMessage,
  channelId: string,
  kind: string,
  writeAccess: string[],
) {
  switch (action) {
    case "ignore":
      return;
    case "flag_sensitive":
      log.warn(`Classifier flag_sensitive: channel=${channelId} user=${message.user} ts=${message.ts}`);
      await broadcast("sensitive_content_detected", {
        source: "classifier",
        meta: { slack_channel_id: channelId, slack_user_id: message.user, ts: message.ts },
      });
      return;
    case "create_memory":
      return createMemory(result, message, channelId, writeAccess);
    case "create_absence":
      return createAbsence(result, message, channelId, kind, writeAccess);
    case "create_meeting":
      await setFact(`meeting:${channelId}:${message.ts || "0"}`, message.text ?? "", writeAccess, "system");
      return;
    case "ask_human":
      return askHuman(result, message, channelId, kind, writeAccess);
    default:
      log.warn(`Classifier unknown action: ${action}`);
  }
}

async function createMemory(result: Result, message: BufferedMessage, channelId: string, writeAccess: string[]) {
  const note = noteOrText(result, message);
  const userId = await findUserId(message.user);
  if (!userId) {
    log.debug(`Classifier create_memory: skipping — user ${message.user} not in system`);
    return;
  }
  let embedding: number[];
  try {
    embedding = await embedQuery(note);
  } catch (error) {
    log.error(`Classifier embed error: ${(error as Error).message}`);
    return;
  }
  await createNode(userId, writeAccess, { content: note, embedding, projectId: await projectIdForChannel(channelId) });
}

async function createAbsence(
  result: Result,
  message: BufferedMessage,
  channelId: string,
  kind: string,
  writeAccess: string[],
) {
  const text = message.text ?? "";
  const userName = message.user_name ?? message.user ?? "unknown";
  const userId = await findUserId(message.user);
  const { startDate, endDate } = absenceDates(result);
  const note = noteOrText(result, message);
  const overlapping = userId !== null && (await overlappingAbsences(userId, startDate, endDate)).length > 0;

  if (overlapping && result.flagged === true) {
    const { fact } = await putAbsence(userId!, startDate, endDate, note, writeAccess);
    await createAbsenceNode(userId!, fact.access, note, channelId);
    return;
  }
  if (overlapping) {
    log.debug(`Classifier create_absence: already covered for ${userId}, skipping`);
    return;
  }

  const key = `absence:${userId ?? userName}:${startDate}`;
  await setFact(key, `${startDate}..${endDate} — ${absenceDescription(note, text)}`, writeAccess, userId);
  if (!userId) return;

  const node = await createAbsenceNode(userId, writeAccess, note, channelId);
  if (!node) return;

  const proposal = await escalationProposal(channelId, kind, writeAccess, "absence");
  if (proposal) await postEscalationQuestion(channelId, message, node, proposal, writeAccess, lang(result), key);
  if (result.working !== true) await maybeOfferFirmowidLeaveRequest(userId, startDate, endDate);
}

async function askHuman(result: Result, message: BufferedMessage, channelId: string, kind: string, writeAccess: string[]) {
  const note = noteOrText(result, message);
  const proposal = await escalationProposal(channelId, kind, writeAccess, "note");
  if (!proposal) {
    log.info(`Classifier ask_human skipped for ${channelId}: no escalation target`);
    return;
  }
  const userId = await findUserId(message.user);
  if (!userId) {
    log.debug(`Classifier ask_human: skipping — user ${message.user} not in system`);
    return;
  }
  try {
    const embedding = await embedQuery(note);
    const node = await createNode(userId, writeAccess, {
      content: note,
      embedding,
      projectId: await projectIdForChannel(channelId),
    });
    await postEscalationQuestion(channelId, message, node, proposal, writeAccess, lang(result), null);
  } catch (error) {
    log.info(`Classifier ask_human skipped for ${channelId}: ${(error as Error).message}`);
  }
}

const absenceDescription = (note: string, text: string) => (note === text ? `"${text}"` : `${note} ("${text}")`);

async function createAbsenceNode(userId: string, access: string[], note: string, channelId: string): Promise<Node | null> {
  try {
    const embedding = await embedQuery(note);
    return await createNode(userId, access, { content: note, embedding, projectId: await projectIdForChannel(channelId) });
  } catch (error) {
    log.error(`Classifier create_absence node error: ${(error as Error).message}`);
    return null;
  }
}

function applyPendingFlag(flag: Flag | null, result: Result): [string, Result] {
  if (!flag) return [result.action ?? "ignore", result];
  const merged: Result = { ...result, flagged: true };
  if (flag.content != null) merged.note = flag.content;
  if (flag.start_date != null) merged.start_date = flag.start_date;
  if (flag.end_date != null) merged.end_date = flag.end_date;
  if (flag.working != null) merged.working = flag.working;
  return [flag.action, merged];
}

async function runOps(ops: PendingOp[]) {
  for (const op of ops) {
    switch (op.op) {
      case "escalate":
        await escalateNoteAccess(op.node_id, op.level, op.readable_levels);
        break;
      case "delete":
        await deleteNode(op.user_id, op.node_id);
        break;
      case "link":
        await createLink(op.user_id, op.a, op.b);
        break;
      case "unlink":
        await deleteLink(op.user_id, op.a, op.b);
        break;
      default:
        log.warn(`Classifier: unknown pending op ${JSON.stringify(op)}`);
    }
  }
}

function noteOrText(result: Result, message: BufferedMessage): string {
  return typeof result.note === "string" && result.note !== "" ? result.note : (message.text ?? "");
}

const lang = (result: Result): Lang => (result.lang === "pl" ? "pl" : "en");

function absenceDates(result: Result) {
  const valid = (value: unknown) => (typeof value === "string" && isValidIsoDate(value) ? value : null);
  const startDate = valid(result.start_date) ?? localToday();
  const endDate = valid(result.end_date) ?? startDate;
  return { startDate, endDate };
}

async function maybeOfferFirmowidLeaveRequest(userId: string, startDate: string, endDate: string) {
  const connection = await getConnection(userId, "firmowid");
  if (!connection || connection.status === "disconnected") return;
  if (!(await ensureValidToken(connection)).ok) return;
  const body = getBody("firmowid-leave-offer");
  if (!body) return;
  const prompt = body.replaceAll("{{start_date}}", startDate).replaceAll("{{end_date}}", endDate);
  const sent = await sendProactive(userId, prompt);
  if (!sent.ok) log.debug(`Classifier: failed to offer Firmowid leave request to ${userId}: ${sent.error}`);
}

interface Proposal {
  options: string[];
  preselected: string[];
}

async function escalationProposal(
  channelId: string,
  kind: string,
  writeAccess: string[],
  purpose: "absence" | "note",
): Promise<Proposal | null> {
  if (kind === "project_external") return null;
  if (isPrivate(writeAccess)) {
    return purpose === "absence"
      ? { options: ["internal", "external/all"], preselected: ["internal", "external/all"] }
      : { options: ["internal", "external/all"], preselected: ["internal"] };
  }
  if (purpose === "absence") {
    return writeAccess.includes("external/all") ? null : { options: ["external/all"], preselected: ["external/all"] };
  }
  if (kind === "priv_channel") return { options: ["external/all"], preselected: ["external/all"] };
  if (kind === "project_internal") {
    const clientId = await clientIdForChannel(channelId);
    return clientId ? { options: [`external/${clientId}`], preselected: [`external/${clientId}`] } : null;
  }
  return null;
}

function levelDescription(language: Lang, level: string): string {
  if (level === "internal") return language === "pl" ? "Cały zespół Manfrod — bez klientów" : "The whole Manfrod team — no clients";
  if (level === "external/all") {
    return language === "pl" ? "Zespół + wszyscy klienci (urlopy, nieobecności)" : "Team + all clients (vacations, absences)";
  }
  if (level.startsWith("external/")) {
    const client = level.slice("external/".length);
    return language === "pl" ? `Zespół + klient ${client}` : `Team + client ${client}`;
  }
  return level;
}

function currentLevelText(language: Lang, writeAccess: string[]): string {
  if (isPrivate(writeAccess)) return language === "pl" ? "tylko u Ciebie (`private`)" : "only visible to you (`private`)";
  return language === "pl" ? `na poziomie \`${writeAccess.join(", ")}\`` : `at the \`${writeAccess.join(", ")}\` level`;
}

function escalationPromptText(language: Lang, content: string, levelText: string): string {
  return language === "pl"
    ? `Zapisałem notatkę:\n> ${content}\nTeraz jest ${levelText}. Gdzie jeszcze ma trafić?`
    : `I saved a note:\n> ${content}\nIt's currently ${levelText}. Where else should it go?`;
}

function checkboxOption(level: string, language: Lang) {
  return {
    text: { type: "mrkdwn", text: `*${level}*` },
    description: { type: "mrkdwn", text: levelDescription(language, level) },
    value: level,
  };
}

async function postEscalationQuestion(
  channelId: string,
  original: Pick<BufferedMessage, "ts" | "user">,
  node: Node,
  proposal: Proposal,
  writeAccess: string[],
  language: Lang,
  factKey: string | null,
) {
  const prompt = escalationPromptText(language, node.content, currentLevelText(language, writeAccess));
  const initial = proposal.options.filter((level) => proposal.preselected.includes(level)).map((level) => checkboxOption(level, language));
  const checkboxes: Record<string, unknown> = {
    type: "checkboxes",
    action_id: LEVELS_ACTION_ID,
    options: proposal.options.map((level) => checkboxOption(level, language)),
  };
  if (initial.length > 0) checkboxes.initial_options = initial;

  const blocks = [
    { type: "section", block_id: LEVELS_BLOCK_ID, text: { type: "mrkdwn", text: prompt }, accessory: checkboxes },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "memory_escalation_save",
          style: "primary",
          text: { type: "plain_text", text: language === "pl" ? "Zapisz" : "Save", emoji: true },
        },
        {
          type: "button",
          action_id: "memory_escalation_cancel",
          text: { type: "plain_text", text: language === "pl" ? "Anuluj" : "Cancel", emoji: true },
        },
      ],
    },
  ];

  const response = await post("chat.postMessage", { channel: channelId, thread_ts: original.ts, text: prompt, blocks });
  if (!response.ok) {
    log.error(`Classifier ask_human: failed to post: ${response.error}`);
    return;
  }
  await putConfirmation(response.body.ts, channelId, {
    node_id: node.id,
    options: proposal.options,
    preselected: proposal.preselected,
    write_access: writeAccess,
    fact_key: factKey,
    lang: language,
    ...(original.user ? { author_slack_id: original.user } : {}),
  });
  log.info(
    `Classifier ask_human: posted escalation prompt on ${channelId}/${original.ts} (options: ${proposal.options.join(", ")})`,
  );
}

export function canResolveEscalation(payload: Pick<ConfirmationPayload, "author_slack_id">, slackUserId: string | undefined): boolean {
  return !payload.author_slack_id || payload.author_slack_id === slackUserId;
}

export async function resolveEscalation(
  decision: "save" | "cancel",
  selectedLevels: string[],
  channelId: string,
  botTs: string,
  clicker: { slackUserId: string | undefined; threadTs: string | undefined },
): Promise<void> {
  const pending = await getConfirmation(botTs);
  if (!pending || pending.channelId !== channelId) {
    log.debug(`Classifier resolve_escalation: no pending entry for ${botTs}`);
    return;
  }
  if (!canResolveEscalation(pending.payload, clicker.slackUserId)) {
    log.info(`Classifier resolve_escalation: ${clicker.slackUserId} is not the author of ${botTs}, ignoring`);
    if (clicker.slackUserId) {
      await post("chat.postEphemeral", {
        channel: channelId,
        thread_ts: clicker.threadTs,
        user: clicker.slackUserId,
        text:
          pending.payload.lang === "pl"
            ? "Tylko autor wiadomości może zdecydować, komu udostępnić tę notatkę."
            : "Only the author of the message can decide who this note is shared with.",
      });
    }
    return;
  }
  await deleteConfirmation(botTs);
  const { payload } = pending;
  const levels = decision === "save" ? selectedLevels.filter((level) => payload.options.includes(level)) : [];
  const outcome = await applyEscalation(levels, payload);
  await post("chat.update", {
    channel: channelId,
    ts: botTs,
    text: outcome,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: outcome } }],
  });
}

export async function preselectedLevels(botTs: string): Promise<string[]> {
  return (await getConfirmation(botTs))?.payload.preselected ?? [];
}

const formatLevels = (levels: string[]) => levels.map((level) => `\`${level}\``).join(", ");

async function applyEscalation(levels: string[], payload: ConfirmationPayload): Promise<string> {
  const language = payload.lang ?? "en";
  const writeAccess = payload.write_access;
  if (levels.length === 0) {
    return language === "pl"
      ? `👌 OK, notatka zostaje ${currentLevelText("pl", writeAccess)}.`
      : `👌 OK, the note stays ${currentLevelText("en", writeAccess)}.`;
  }

  const applied: string[] = [];
  const failed: string[] = [];
  const ordered = [...levels].sort((a, b) => (a === "internal" ? 0 : 1) - (b === "internal" ? 0 : 1));
  for (const level of ordered) {
    if (payload.fact_key) {
      try {
        await addAccess(payload.fact_key, level);
      } catch (error) {
        log.warn(`Classifier widen_fact_access failed for ${payload.fact_key}: ${(error as Error).message}`);
      }
    }
    const base = isPrivate(writeAccess) ? [...writeAccess, "internal"] : writeAccess;
    const result = await escalateNoteAccess(payload.node_id, level, [...new Set([...base, ...applied])]);
    if (result.ok) {
      applied.push(level);
    } else {
      log.warn(`Classifier escalation to ${level} failed for ${payload.node_id}: ${JSON.stringify(result.error)}`);
      failed.push(level);
    }
  }

  if (applied.length === 0) {
    return language === "pl"
      ? `⚠️ Nie udało się rozszerzyć dostępu — notatka zostaje ${currentLevelText("pl", writeAccess)}.`
      : `⚠️ Couldn't widen access — the note stays ${currentLevelText("en", writeAccess)}.`;
  }
  if (failed.length === 0) {
    return language === "pl" ? `✅ Zapisane też jako ${formatLevels(applied)}.` : `✅ Also saved as ${formatLevels(applied)}.`;
  }
  return language === "pl"
    ? `✅ Zapisane też jako ${formatLevels(applied)}.\n⚠️ Nie udało się: ${formatLevels(failed)}.`
    : `✅ Also saved as ${formatLevels(applied)}.\n⚠️ Couldn't save: ${formatLevels(failed)}.`;
}

const CHANNEL_TYPES: Record<string, string> = {
  project_internal: "private project channel (team only — client cannot see this)",
  project_external: "shared with client (external/<client_id>)",
  company_channel: "internal company channel",
  priv_channel: "direct message / private channel (priv)",
};

const RESOLVED_SCOPES: Record<string, string> = {
  priv_channel: "private/<user_id> — the author's own space; sharing wider is confirmed by them",
  company_channel: "internal",
  project_internal: "internal",
  project_external: "internal + external/<client_id>",
};

function formatMessage(message: BufferedMessage, kind: string): string {
  return `Channel: ${kind}
Channel type: ${CHANNEL_TYPES[kind] ?? "unknown"}
Resolved scope: ${RESOLVED_SCOPES[kind] ?? "none"}
User: ${message.user_name ?? message.user ?? "unknown"}
Message: "${message.text ?? ""}"
`;
}

export function parseBulkResponse(raw: string): { ok: true; results: Result[] } | { ok: false; error: string } {
  const cleaned = raw.replace(/```json\s*/gi, "").replaceAll("```", "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? { ok: true, results: parsed } : { ok: false, error: "expected JSON array, got object or scalar" };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
