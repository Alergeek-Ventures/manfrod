import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { DeskPlan, OfficeVisit } from "../db/schema.ts";
import { listReservationsForDate, type ReservationWithDesk } from "../desks.ts";
import { logger } from "../log.ts";
import { decide } from "../nudges/compose.ts";
import { getPermalink, post } from "../slack/api.ts";
import { addDays, localToday } from "../time.ts";
import { assignDesks, guestNames, personKey, seatingSignature, type AssignPerson, type AssignResult } from "./assign.ts";
import { AWAY_STATUSES } from "./away.ts";
import { loadOffice, type Office } from "./layout.ts";
import { planMessage, type PlanSeat } from "./plan-message.ts";
import { crowding, fallbackIntro, planTitle } from "./plan-rules.ts";
import { getPlan, savePlan, updatePlan } from "./plan-store.ts";
import { predictOfficeDay, type OfficeDayPrediction } from "./presence.ts";
import { deskMapUrl } from "./url.ts";

const { deskReservations, officePresence, projectMemberships, users } = tables;
const log = logger("Office.Plan");

export const HISTORY_DAYS = 60;

export type PlannedPerson = AssignPerson & { slackId: string | null };

export type DayEvaluation = {
  date: string;
  office: Office;
  prediction: OfficeDayPrediction;
  people: PlannedPerson[];
  reservations: ReservationWithDesk[];
  away: Set<string>;
  demand: number;
  supply: number;
  expectedInOffice: number;
  visitNotes: string[];
  crowded: boolean;
  reasons: string[];
};

function visitGuests(visits: OfficeVisit[]): PlannedPerson[] {
  const guests: PlannedPerson[] = [];
  visits.forEach((visit, index) => {
    const before = guestNames(visits.slice(0, index)).length;
    for (const name of guestNames(visits.slice(0, index + 1)).slice(before))
      guests.push({
        key: personKey({ userId: null, guestName: name }),
        userId: null,
        guestName: name,
        name,
        groups: [`visit:${visit.id}`],
        slackId: null,
      });
  });
  return guests;
}

async function statedVisitors(date: string, known: Set<string>) {
  const rows = await db
    .select({ userId: users.id, name: users.name, slackId: users.slackId })
    .from(officePresence)
    .innerJoin(users, eq(users.id, officePresence.userId))
    .where(and(eq(officePresence.date, date), eq(officePresence.status, "office")));
  return rows.filter((row) => !known.has(row.userId));
}

export type DayInput = {
  date: string;
  office: Office;
  prediction: OfficeDayPrediction;
  reservations: ReservationWithDesk[];
  stated: { userId: string; name: string | null; slackId: string }[];
};

export function summarizeDay({ date, office, prediction, reservations: all, stated }: DayInput): DayEvaluation {
  const visitGroups = new Map<string, string[]>();
  for (const visit of prediction.visits)
    for (const userId of visit.userIds) visitGroups.set(userId, [...(visitGroups.get(userId) ?? []), `visit:${visit.id}`]);

  const present = [...prediction.people.filter((person) => person.status === "office"), ...stated].map((person): PlannedPerson => ({
    key: personKey({ userId: person.userId, guestName: null }),
    userId: person.userId,
    guestName: null,
    name: person.name ?? person.slackId,
    groups: visitGroups.get(person.userId) ?? [],
    slackId: person.slackId,
  }));
  const people = [...present, ...visitGuests(prediction.visits)];
  const away = new Set(
    prediction.people.filter((person) => (AWAY_STATUSES as readonly string[]).includes(person.status)).map((person) => person.userId),
  );

  const deskIds = new Set(office.desks.map((desk) => desk.id));
  const reservations = all.filter((reservation) => deskIds.has(reservation.deskId));
  const manual = reservations.filter((reservation) => reservation.source === "manual");
  const manualKeys = new Set(manual.map(personKey));
  const manualDesks = new Set(manual.map((reservation) => reservation.deskId));
  const owners = new Set(office.desks.flatMap((desk) => (desk.ownerUserId ? [desk.ownerUserId] : [])));
  const demand = people.filter((person) => !manualKeys.has(person.key) && !(person.userId && owners.has(person.userId))).length;
  const supply = office.desks.filter((desk) => !desk.ownerUserId && !manualDesks.has(desk.id)).length;
  const expectedInOffice = prediction.expectedInOffice + stated.length;
  const visitNotes = prediction.visits.map((visit) => visit.note);
  const { crowded, reasons } = crowding({ visitNotes, demand, supply, expectedInOffice, threshold: office.layout.crowdedThreshold });
  return { date, office, prediction, people, reservations, away, demand, supply, expectedInOffice, visitNotes, crowded, reasons };
}

export async function evaluateDay(date: string, opts: { today?: string } = {}): Promise<DayEvaluation> {
  const office = await loadOffice();
  const [prediction, reservations] = await Promise.all([
    predictOfficeDay(date, { layoutId: office.layout.id, today: opts.today }),
    listReservationsForDate(date),
  ]);
  const stated = await statedVisitors(date, new Set(prediction.people.map((person) => person.userId)));
  return summarizeDay({ date, office, prediction, reservations, stated });
}

async function recentDesks(layoutDeskIds: string[], userIds: string[], date: string): Promise<Map<string, string>> {
  const recent = new Map<string, string>();
  if (userIds.length === 0 || layoutDeskIds.length === 0) return recent;
  const rows = await db
    .select({ userId: deskReservations.userId, deskId: deskReservations.deskId })
    .from(deskReservations)
    .where(
      and(
        inArray(deskReservations.userId, userIds),
        inArray(deskReservations.deskId, layoutDeskIds),
        lt(deskReservations.date, date),
        gte(deskReservations.date, addDays(date, -HISTORY_DAYS)),
      ),
    )
    .orderBy(desc(deskReservations.date), desc(deskReservations.insertedAt));
  for (const row of rows) if (row.userId && !recent.has(`user:${row.userId}`)) recent.set(`user:${row.userId}`, row.deskId);
  return recent;
}

async function projectGroups(userIds: string[]): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>();
  if (userIds.length === 0) return groups;
  const rows = await db
    .select({ userId: projectMemberships.userId, projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .where(and(inArray(projectMemberships.userId, userIds), isNull(projectMemberships.removedAt)));
  for (const row of rows) groups.set(row.userId, [...(groups.get(row.userId) ?? []), `project:${row.projectId}`]);
  return groups;
}

export type PreparedPlan = {
  evaluation: DayEvaluation;
  result: AssignResult;
  plan: DeskPlan;
  changed: boolean;
};

const PLANNED_REASONS = new Set(["previous", "recent", "cluster"]);

export async function preparePlan(
  date: string,
  opts: { today?: string; evaluation?: DayEvaluation; status?: "heads_up" | "posted" } = {},
): Promise<PreparedPlan> {
  const evaluation = opts.evaluation ?? (await evaluateDay(date, opts));
  const { office, people, reservations } = evaluation;
  const userIds = people.flatMap((person) => (person.userId ? [person.userId] : []));
  const deskIds = office.desks.map((desk) => desk.id);
  const [recentDesk, groups, existing] = await Promise.all([
    recentDesks(deskIds, userIds, date),
    projectGroups(userIds),
    getPlan(office.layout.id, date),
  ]);
  const planned = reservations.filter((reservation) => reservation.source === "plan");
  const result = assignDesks({
    desks: office.desks,
    people: people.map((person) => ({ ...person, groups: [...person.groups, ...((person.userId && groups.get(person.userId)) || [])] })),
    awayUserIds: evaluation.away,
    manual: reservations
      .filter((reservation) => reservation.source === "manual")
      .map((reservation) => ({
        deskId: reservation.deskId,
        userId: reservation.userId,
        guestName: reservation.guestName,
        name: reservation.name,
      })),
    previous: new Map(planned.map((reservation) => [personKey(reservation), reservation.deskId])),
    recentDesk,
  });
  const seating = seatingSignature(result);
  const awayUserIds = [...evaluation.away].sort();
  const changed =
    !existing || existing.seating !== seating || JSON.stringify([...existing.awayUserIds].sort()) !== JSON.stringify(awayUserIds);

  if (changed) {
    const displacedKeys = new Set(result.displaced.map((person) => person.key));
    const ownerDesks = new Set(office.desks.filter((desk) => desk.ownerUserId).map((desk) => desk.id));
    const toDrop = reservations
      .filter(
        (reservation) => reservation.source === "plan" || (displacedKeys.has(personKey(reservation)) && ownerDesks.has(reservation.deskId)),
      )
      .map((reservation) => reservation.id);
    const toInsert = result.assignments
      .filter((assignment) => PLANNED_REASONS.has(assignment.reason))
      .map((assignment) => ({
        deskId: assignment.deskId,
        userId: assignment.userId,
        guestName: assignment.guestName,
        date,
        source: "plan",
      }));
    await db.transaction(async (tx) => {
      if (toDrop.length > 0) await tx.delete(deskReservations).where(inArray(deskReservations.id, toDrop));
      if (toInsert.length > 0) await tx.insert(deskReservations).values(toInsert);
    });
  }
  const plan = await savePlan(office.layout.id, date, {
    status:
      existing?.status === "posted" ? "posted" : (opts.status ?? (existing?.status as "heads_up" | "declined" | undefined) ?? "heads_up"),
    awayUserIds,
    seating,
  });
  return { evaluation, result, plan, changed };
}

export function planSeats(result: AssignResult): PlanSeat[] {
  return result.assignments.map((assignment) => ({ label: assignment.label, name: assignment.name }));
}

export function displacedNotes(prepared: Pick<PreparedPlan, "evaluation" | "result">): string[] {
  const slack = new Map(prepared.evaluation.people.map((person) => [person.key, person.slackId]));
  return prepared.result.displaced.map((person) => {
    const seat = prepared.result.assignments.find((assignment) => assignment.key === person.key);
    const who = slack.get(person.key) ? `<@${slack.get(person.key)}>` : person.name;
    return `${who}: właściciel wraca do swojego biurka, ${seat ? `siedzisz teraz przy *${seat.label}*` : "nie ma już wolnego biurka"}.`;
  });
}

export function renderPlanMessage(prepared: PreparedPlan, intro: string, notes: string[] = []) {
  return planMessage({
    date: prepared.plan.date,
    title: planTitle(prepared.plan.date),
    intro,
    imageUrl: deskMapUrl(prepared.plan.date, prepared.plan.version),
    seats: planSeats(prepared.result),
    overflow: prepared.result.overflow.map((person) => person.name),
    notes: [...displacedNotes(prepared), ...notes],
    version: prepared.plan.version,
  });
}

async function draftIntro(evaluation: DayEvaluation, today: string): Promise<string> {
  const fallback = fallbackIntro(evaluation.date, today, evaluation.expectedInOffice, evaluation.visitNotes);
  try {
    const decision = await decide({
      kind: "desk plan intro",
      audience: "the office channel, where the desk plan for the next office day is posted",
      guidance:
        "Write one short sentence that introduces the desk plan below it and says why it is needed (how many people are expected, who is visiting). Always send. No greeting, no list, no emoji, no names of desks.",
      context: [
        `Date: ${evaluation.date}`,
        `Expected in the office: ~${evaluation.expectedInOffice}`,
        ...evaluation.reasons.map((reason) => `Reason: ${reason}`),
        `Example: ${fallback}`,
      ].join("\n"),
    });
    return decision?.send ? decision.message : fallback;
  } catch (error) {
    log.warn(`Office.Plan: intro draft failed: ${(error as Error).message}`);
    return fallback;
  }
}

export type PostResult = { ok: true; plan: DeskPlan; permalink: string | null; posted: boolean } | { ok: false; error: string };

export async function postPlan(date: string, opts: { today?: string; evaluation?: DayEvaluation } = {}): Promise<PostResult> {
  const office = opts.evaluation?.office ?? (await loadOffice());
  const channel = office.layout.planChannelId;
  if (!channel) return { ok: false, error: "no_plan_channel" };
  const existing = await getPlan(office.layout.id, date);
  if (existing?.status === "posted" && existing.messageTs && existing.channelId) {
    const refreshed = await refreshPlan(date, { force: true });
    return refreshed.ok
      ? { ok: true, plan: refreshed.plan ?? existing, permalink: await getPermalink(existing.channelId, existing.messageTs), posted: false }
      : refreshed;
  }
  const today = opts.today ?? localToday();
  const prepared = await preparePlan(date, { today, evaluation: opts.evaluation });
  const intro = await draftIntro(prepared.evaluation, today);
  const sent = await post("chat.postMessage", { channel, unfurl_links: false, ...renderPlanMessage(prepared, intro) });
  if (!sent.ok) return { ok: false, error: sent.error };
  const plan = await savePlan(office.layout.id, date, {
    status: "posted",
    channelId: channel,
    messageTs: sent.body.ts as string,
    reason: intro,
  });
  return { ok: true, plan, permalink: await getPermalink(channel, plan.messageTs!), posted: true };
}

export type RefreshResult =
  { ok: true; updated: boolean; plan: DeskPlan | null; prepared: PreparedPlan | null } | { ok: false; error: string };

export async function refreshPlan(date: string, opts: { force?: boolean; notes?: string[]; today?: string } = {}): Promise<RefreshResult> {
  const office = await loadOffice();
  const plan = await getPlan(office.layout.id, date);
  if (!plan || plan.status !== "posted" || !plan.channelId || !plan.messageTs) return { ok: true, updated: false, plan, prepared: null };
  const prepared = await preparePlan(date, { today: opts.today });
  if (!prepared.changed && !opts.force) return { ok: true, updated: false, plan: prepared.plan, prepared };
  const bumped = (await updatePlan(office.layout.id, date, { bumpVersion: true })) ?? prepared.plan;
  const next = { ...prepared, plan: bumped };
  const intro =
    plan.reason ?? fallbackIntro(date, opts.today ?? localToday(), prepared.evaluation.expectedInOffice, prepared.evaluation.visitNotes);
  const updated = await post("chat.update", { channel: plan.channelId, ts: plan.messageTs, ...renderPlanMessage(next, intro, opts.notes) });
  if (!updated.ok) return { ok: false, error: updated.error };
  return { ok: true, updated: true, plan: bumped, prepared: next };
}

export async function refreshPlans(dates: string[], opts: { force?: boolean } = {}): Promise<string[]> {
  const updated: string[] = [];
  for (const date of [...new Set(dates)].sort()) {
    try {
      const result = await refreshPlan(date, opts);
      if (result.ok && result.updated) updated.push(date);
      if (!result.ok) log.warn(`Office.Plan: refreshing the plan for ${date} failed: ${result.error}`);
    } catch (error) {
      log.error(`Office.Plan: refreshing the plan for ${date} failed: ${(error as Error).message}`);
    }
  }
  return updated;
}
