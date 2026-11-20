import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { DeskPlan, OfficeVisit } from "../db/schema.ts";
import { listReservationsForDate, type ReservationWithDesk } from "../desks.ts";
import { logger } from "../log.ts";
import { decide } from "../nudges/compose.ts";
import { getPermalink, post, type SlackBody } from "../slack/api.ts";
import { addDays } from "../time.ts";
import { assignDesks, personKey, seatingSignature, type AssignResult } from "./assign.ts";
import { isConfirmedAway } from "./away.ts";
import { loadOffice, type Office } from "./layout.ts";
import { planMessage, type PlanSeat } from "./plan-message.ts";
import { crowding, dayLabel, isLongStay, longStayNote, planHeadline, planReasonLine, planTitle, visitSummary } from "./plan-rules.ts";
import {
  CLAIM_TIMEOUT_MS,
  deletePlan,
  deletePlanSeats,
  getPlan,
  savePlan,
  updatePlan,
  withPlanLock,
  type Executor,
  type PlanStatus,
} from "./plan-store.ts";
import { predictOfficeDay, type OfficeDayPrediction } from "./presence.ts";
import { loadMembers } from "./presence-sources.ts";
import { deskMapUrl } from "./url.ts";
import { dayRoster, isDormant, type RosterPerson } from "./roster.ts";
import { visitPlace } from "./visit-guests.ts";

const { deskReservations, projectMemberships } = tables;
const log = logger("Office.Plan");

export const HISTORY_DAYS = 60;

export type PlannedPerson = RosterPerson;

export type VisitLine = { id: string; summary: string; long: boolean };

export type DayEvaluation = {
  date: string;
  office: Office;
  prediction: OfficeDayPrediction;
  people: PlannedPerson[];
  reservations: ReservationWithDesk[];
  away: Set<string>;
  dormantDeskIds: Set<string>;
  demand: number;
  supply: number;
  expectedInOffice: number;
  visits: VisitLine[];
  longStays: string[];
  visitExtraPeople: number;
  crowded: boolean;
  crowdedWithoutVisits: boolean;
  reasons: string[];
  visitReasons: string[];
  deskReasons: string[];
};

export type DayInput = {
  date: string;
  office: Office;
  prediction: OfficeDayPrediction;
  reservations: ReservationWithDesk[];
  memberIds: ReadonlySet<string>;
};

function visitLine(visit: OfficeVisit, names: ReadonlyMap<string, string>): VisitLine {
  const people = [...visit.userIds.flatMap((userId) => names.get(userId) ?? []), ...visit.guestNames];
  const anonymous = Math.max(visit.guests - visit.guestNames.length, 0);
  return { id: visit.id, summary: visitSummary(people, anonymous, visitPlace(visit.note)), long: isLongStay(visit) };
}

export function summarizeDay({ date, office, prediction, reservations: all, memberIds }: DayInput): DayEvaluation {
  const activeDesks = new Set(office.desks.filter((desk) => desk.active).map((desk) => desk.id));
  const away = new Set(prediction.people.filter(isConfirmedAway).map((person) => person.userId));
  const reservations = all.filter((reservation) => activeDesks.has(reservation.deskId));
  const booked = reservations.filter((reservation) => reservation.source === "manual");
  const dormantDeskIds = new Set(booked.filter((reservation) => isDormant(reservation, away)).map((reservation) => reservation.deskId));
  const manual = booked.filter((reservation) => !isDormant(reservation, away));
  const roster = dayRoster({
    people: prediction.people,
    visits: prediction.visits,
    manual: manual.map((reservation) => ({
      userId: reservation.userId,
      guestName: reservation.guestName,
      name: reservation.name,
      slackId: reservation.user?.slackId ?? null,
    })),
    memberIds,
    away,
  });
  const people = roster.people;
  const guestList = roster.guestList;
  const manualKeys = new Set(manual.map(personKey));
  const manualDesks = new Set(manual.map((reservation) => reservation.deskId));
  const owners = new Set(office.desks.flatMap((desk) => (desk.ownerUserId ? [desk.ownerUserId] : [])));
  const demand = people.filter((person) => !manualKeys.has(person.key) && !(person.userId && owners.has(person.userId))).length;
  const supply = office.desks.filter((desk) => !desk.ownerUserId && !manualDesks.has(desk.id) && !dormantDeskIds.has(desk.id)).length;
  const expectedInOffice = people.length;

  const names = new Map(prediction.people.map((person) => [person.userId, person.name ?? person.slackId]));
  const visits = prediction.visits.map((visit) => visitLine(visit, names));
  const shortVisits = new Set(visits.filter((visit) => !visit.long).map((visit) => visit.id));
  const visitors = new Set(
    prediction.visits
      .filter((visit) => shortVisits.has(visit.id))
      .flatMap((visit) => visit.userIds.filter((userId) => !memberIds.has(userId))),
  );
  const visitExtraPeople = guestList.filter((guest) => shortVisits.has(guest.visitId)).length + visitors.size;
  const longStays = prediction.visits
    .filter((visit) => !shortVisits.has(visit.id))
    .flatMap((visit) => {
      const newcomers = visit.userIds.filter((userId) => !memberIds.has(userId)).flatMap((userId) => names.get(userId) ?? []);
      return newcomers.length > 0 ? [longStayNote(newcomers, visit.endsOn)] : [];
    });
  const { crowded, crowdedWithoutVisits, reasons, visitReasons, deskReasons } = crowding({
    visitSummaries: visits.filter((visit) => !visit.long).map((visit) => visit.summary),
    visitExtraPeople,
    demand,
    supply,
    expectedInOffice,
    threshold: office.layout.crowdedThreshold,
  });
  return {
    date,
    office,
    prediction,
    people,
    reservations,
    away,
    dormantDeskIds,
    demand,
    supply,
    expectedInOffice,
    visits,
    longStays,
    visitExtraPeople,
    crowded,
    crowdedWithoutVisits,
    reasons,
    visitReasons,
    deskReasons,
  };
}

export async function evaluateDay(date: string, opts: { today?: string } = {}): Promise<DayEvaluation> {
  const office = await loadOffice();
  const [prediction, reservations, members] = await Promise.all([
    predictOfficeDay(date, { layoutId: office.layout.id, today: opts.today }),
    listReservationsForDate(date),
    loadMembers(office.layout.id),
  ]);
  const memberIds = new Set(members.map((member) => member.userId));
  return summarizeDay({ date, office, prediction, reservations, memberIds });
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

async function prepareLocked(tx: Executor, date: string, opts: { today?: string; status: PlanStatus }): Promise<PreparedPlan> {
  const evaluation = await evaluateDay(date, opts);
  const { office, people, reservations } = evaluation;
  const userIds = people.flatMap((person) => (person.userId ? [person.userId] : []));
  const deskIds = office.desks.map((desk) => desk.id);
  const [recentDesk, groups, existing] = await Promise.all([
    recentDesks(deskIds, userIds, date),
    projectGroups(userIds),
    getPlan(office.layout.id, date, tx),
  ]);
  const planned = reservations.filter((reservation) => reservation.source === "plan");
  const guestKeys = new Map(
    people.flatMap((person) => (person.userId ? [] : [[(person.guestName ?? "").toLowerCase(), person.key] as const])),
  );
  const rosterKey = (reservation: ReservationWithDesk) =>
    (!reservation.userId && guestKeys.get((reservation.guestName ?? "").toLowerCase())) || personKey(reservation);
  const result = assignDesks({
    desks: office.desks.filter((desk) => !evaluation.dormantDeskIds.has(desk.id)),
    people: people.map((person) => ({ ...person, groups: [...person.groups, ...((person.userId && groups.get(person.userId)) || [])] })),
    awayUserIds: evaluation.away,
    manual: reservations
      .filter((reservation) => reservation.source === "manual" && !isDormant(reservation, evaluation.away))
      .map((reservation) => ({
        deskId: reservation.deskId,
        userId: reservation.userId,
        guestName: reservation.guestName,
        name: reservation.name,
      })),
    previous: new Map(planned.map((reservation) => [rosterKey(reservation), reservation.deskId])),
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
    if (toDrop.length > 0) await tx.delete(deskReservations).where(inArray(deskReservations.id, toDrop));
    if (toInsert.length > 0) await tx.insert(deskReservations).values(toInsert);
  }
  const plan = await savePlan(office.layout.id, date, { status: opts.status, awayUserIds, seating }, tx);
  return { evaluation, result, plan, changed };
}

export async function preparePlan(date: string, opts: { today?: string } = {}): Promise<PreparedPlan> {
  const office = await loadOffice();
  return withPlanLock(office.layout.id, date, async (tx) => {
    const existing = await getPlan(office.layout.id, date, tx);
    return prepareLocked(tx, date, { today: opts.today, status: (existing?.status as PlanStatus | undefined) ?? "heads_up" });
  });
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

export function planSummary(prepared: Pick<PreparedPlan, "evaluation" | "result" | "plan">): { headline: string; reason: string } {
  const seated = [...prepared.result.assignments, ...prepared.result.overflow];
  const guests = seated.filter((person) => person.userId === null).length;
  const { evaluation } = prepared;
  return {
    headline: planHeadline(prepared.plan.date, seated.length, guests),
    reason: planReasonLine({
      requestedBy: prepared.plan.requestedBy,
      crowded: evaluation.crowded,
      visitReasons: evaluation.visitReasons,
      deskReasons: evaluation.deskReasons,
      seated: seated.length,
      threshold: evaluation.office.layout.crowdedThreshold,
    }),
  };
}

export function renderPlanMessage(prepared: Pick<PreparedPlan, "evaluation" | "result" | "plan">, intro: string, notes: string[] = []) {
  const { headline, reason } = planSummary(prepared);
  return planMessage({
    date: prepared.plan.date,
    title: planTitle(prepared.plan.date),
    headline,
    intro: [reason, intro.trim()].filter(Boolean).join(" "),
    imageUrl: deskMapUrl(prepared.plan.date, prepared.plan.version),
    seats: planSeats(prepared.result),
    overflow: prepared.result.overflow.map((person) => person.name),
    notes: [...displacedNotes(prepared), ...notes, ...prepared.evaluation.longStays],
    version: prepared.plan.version,
  });
}

async function draftIntro(evaluation: DayEvaluation, requested: boolean): Promise<string> {
  try {
    const decision = await decide({
      kind: "desk plan intro",
      audience: "the office channel, where the desk plan for an office day is posted",
      guidance:
        "Write one short sentence that introduces the desk plan below it, e.g. who is visiting or why a plan helps that day. Never state a headcount or any number of people: the message shows the current count above your sentence and it changes later. Name the day by weekday and date if you name it, never 'jutro' or 'dziś': the message stays up and is edited later. Send nothing when there is nothing to add beyond the count. No greeting, no list, no emoji, no names of desks, no ISO dates.",
      context: [
        `Day: ${dayLabel(evaluation.date)}`,
        ...(requested ? ["Someone asked for this plan; the day is not necessarily crowded."] : []),
        ...evaluation.visits.filter((visit) => !visit.long).map((visit) => `Visiting: ${visit.summary}`),
        ...evaluation.deskReasons.map((reason) => `Reason: ${reason}`),
      ].join("\n"),
    });
    return decision?.send ? decision.message : "";
  } catch (error) {
    log.warn(`Office.Plan: intro draft failed: ${(error as Error).message}`);
    return "";
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

export const SYNC_ATTEMPTS = 3;

export async function syncPlanMessage(layoutId: string, date: string): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt++) {
    const plan = await getPlan(layoutId, date);
    if (!plan || plan.status !== "posted" || !plan.channelId || !plan.messageTs || !plan.message) return { ok: true };
    const updated = await post("chat.update", { channel: plan.channelId, ts: plan.messageTs, ...(plan.message as SlackBody) });
    if (!updated.ok) return { ok: false, error: updated.error };
    const latest = await getPlan(layoutId, date);
    if (!latest || latest.version === plan.version) return { ok: true };
  }
  return { ok: true };
}

export type PostResult = { ok: true; plan: DeskPlan; permalink: string | null; posted: boolean } | { ok: false; error: string };

type Claim = { kind: "refresh" } | { kind: "busy" } | { kind: "claimed"; prior: DeskPlan | null; prepared: PreparedPlan };

export async function postPlan(date: string, opts: { today?: string; requestedBy?: string | null } = {}): Promise<PostResult> {
  const office = await loadOffice();
  const layoutId = office.layout.id;
  const channel = office.layout.planChannelId;
  if (!channel) return { ok: false, error: "no_plan_channel" };
  const claim = await withPlanLock(layoutId, date, async (tx): Promise<Claim> => {
    const existing = await getPlan(layoutId, date, tx);
    if (existing?.status === "posted" && existing.messageTs) return { kind: "refresh" };
    if (existing?.status === "posting" && existing.claimedAt && Date.now() - existing.claimedAt.getTime() < CLAIM_TIMEOUT_MS)
      return { kind: "busy" };
    await savePlan(
      layoutId,
      date,
      {
        status: "posting",
        claimedAt: new Date(),
        ...(opts.requestedBy && !existing?.requestedBy ? { requestedBy: opts.requestedBy } : {}),
      },
      tx,
    );
    return { kind: "claimed", prior: existing, prepared: await prepareLocked(tx, date, { today: opts.today, status: "posting" }) };
  });
  if (claim.kind === "busy") return { ok: false, error: "already_posting" };
  if (claim.kind === "refresh") {
    const refreshed = await refreshPlan(date, { force: true, today: opts.today });
    if (!refreshed.ok) return refreshed;
    const plan = refreshed.plan ?? (await getPlan(layoutId, date));
    return {
      ok: true,
      plan: plan!,
      permalink: plan?.messageTs ? await getPermalink(plan.channelId!, plan.messageTs) : null,
      posted: false,
    };
  }

  const intro = await draftIntro(claim.prepared.evaluation, Boolean(claim.prepared.plan.requestedBy));
  const message = renderPlanMessage(claim.prepared, intro);
  const sent = await post("chat.postMessage", { channel, unfurl_links: false, ...message });
  if (!sent.ok) {
    await withPlanLock(layoutId, date, async (tx) => {
      await deletePlanSeats(layoutId, date, tx);
      if (!claim.prior) await deletePlan(layoutId, date, tx);
      else
        await updatePlan(
          layoutId,
          date,
          { status: claim.prior.status, seating: claim.prior.seating, requestedBy: claim.prior.requestedBy, claimedAt: null },
          tx,
        );
    });
    return { ok: false, error: sent.error };
  }
  const plan = await withPlanLock(layoutId, date, (tx) =>
    savePlan(
      layoutId,
      date,
      { status: "posted", channelId: channel, messageTs: sent.body.ts as string, reason: intro, message, claimedAt: null },
      tx,
    ),
  );
  await refreshPlan(date, { today: opts.today }).catch((error) =>
    log.warn(`Office.Plan: catching up the new plan for ${date} failed: ${(error as Error).message}`),
  );
  return { ok: true, plan, permalink: await getPermalink(channel, plan.messageTs!), posted: true };
}

export type RefreshResult =
  { ok: true; updated: boolean; plan: DeskPlan | null; prepared: PreparedPlan | null } | { ok: false; error: string };

export async function refreshPlan(date: string, opts: { force?: boolean; notes?: string[]; today?: string } = {}): Promise<RefreshResult> {
  const office = await loadOffice();
  const layoutId = office.layout.id;
  const current = await getPlan(layoutId, date);
  if (!current || current.status !== "posted" || !current.messageTs) return { ok: true, updated: false, plan: current, prepared: null };
  const outcome = await withPlanLock(layoutId, date, async (tx) => {
    const plan = await getPlan(layoutId, date, tx);
    if (!plan || plan.status !== "posted") return null;
    const prepared = await prepareLocked(tx, date, { today: opts.today, status: "posted" });
    const intro = plan.reason ?? "";
    const unchanged = stableJson(renderPlanMessage(prepared, intro, opts.notes)) === stableJson(plan.message);
    if (!prepared.changed && !opts.force && unchanged) return { prepared, updated: false };
    const bumped = (await updatePlan(layoutId, date, { bumpVersion: true }, tx)) ?? prepared.plan;
    const next = { ...prepared, plan: bumped };
    const saved = await updatePlan(layoutId, date, { message: renderPlanMessage(next, intro, opts.notes) }, tx);
    return { prepared: { ...next, plan: saved ?? bumped }, updated: true };
  });
  if (!outcome) return { ok: true, updated: false, plan: null, prepared: null };
  if (!outcome.updated) return { ok: true, updated: false, plan: outcome.prepared.plan, prepared: outcome.prepared };
  const synced = await syncPlanMessage(layoutId, date);
  if (!synced.ok) return synced;
  return { ok: true, updated: true, plan: outcome.prepared.plan, prepared: outcome.prepared };
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
