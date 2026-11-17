import { and, eq, inArray } from "drizzle-orm";
import { getUser, getUserBySlackId } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import type { User } from "../db/schema.ts";
import { cancelReservationsForDate, reserveDesk } from "../desks.ts";
import { logger } from "../log.ts";
import { openDm, post } from "../slack/api.ts";
import { isValidIsoDate, localToday, withWeekday } from "../time.ts";
import { getLayout } from "./layout.ts";
import { loadMapState } from "./map.ts";
import { postPlan, refreshPlan } from "./plan.ts";
import {
  closedMessage,
  decodeSwap,
  PLAN_ACTION,
  PLAN_CALLBACK,
  selectedValue,
  selectModal,
  swapRequestMessage,
  type SwapRequest,
} from "./plan-message.ts";
import { dayPhrase } from "./plan-rules.ts";
import { getPlan, planAwayUserIds, updatePlan } from "./plan-store.ts";
import { setPresence } from "./presence.ts";
import type { MapState } from "./state.ts";

const { deskReservations } = tables;
const log = logger("Office.PlanActions");

type Payload = Record<string, any>;
type Place = { channel: string | null; threadTs: string | null };

const placeOf = (payload: Payload): Place => ({
  channel: payload.channel?.id ?? null,
  threadTs: payload.message?.thread_ts ?? payload.container?.thread_ts ?? null,
});

async function tell(slackUserId: string | undefined, place: Place, text: string): Promise<void> {
  if (!slackUserId) return;
  if (place.channel && !place.channel.startsWith("D")) {
    await post("chat.postEphemeral", {
      channel: place.channel,
      user: slackUserId,
      text,
      ...(place.threadTs ? { thread_ts: place.threadTs } : {}),
    });
    return;
  }
  await dm(slackUserId, text);
}

async function dm(slackUserId: string, text: string, blocks?: unknown[]): Promise<{ channel: string; ts: string } | null> {
  const channel = await openDm(slackUserId);
  if (!channel) return null;
  const sent = await post("chat.postMessage", { channel, text, ...(blocks ? { blocks } : {}) });
  return sent.ok ? { channel, ts: sent.body.ts as string } : null;
}

const dateOf = (payload: Payload): string | null => {
  const value = payload.actions?.[0]?.value;
  return isValidIsoDate(value) ? value : null;
};

export type SeatOf = { deskId: string; label: string } | null;

export function seatOf(state: MapState, userId: string): SeatOf {
  const desk =
    state.desks.find((candidate) => candidate.reservation?.userId === userId) ??
    state.desks.find((candidate) => candidate.status === "owner_present" && candidate.ownerUserId === userId);
  return desk ? { deskId: desk.id, label: desk.label } : null;
}

async function planState(date: string): Promise<MapState> {
  const layout = await getLayout();
  const away = await planAwayUserIds(layout.id, date);
  return loadMapState(date, away ? { awayUserIds: away } : {});
}

export async function markAway(user: User, date: string): Promise<string> {
  await setPresence(user.id, date, "remote", "button");
  const freed = await cancelReservationsForDate(user.id, date);
  await refreshPlan(date, { force: true });
  const desk = freed.length > 0 ? ` Biurko ${freed.join(", ")} jest wolne.` : "";
  return `Zapisane: ${dayPhrase(date, localToday())} nie będzie Cię w biurze.${desk}`;
}

export async function markComing(user: User, date: string): Promise<string> {
  await setPresence(user.id, date, "office", "button");
  const refreshed = await refreshPlan(date, { force: true });
  const seat = refreshed.ok ? refreshed.prepared?.result.assignments.find((assignment) => assignment.userId === user.id) : undefined;
  const when = dayPhrase(date, localToday());
  if (seat) return `Zapisane: ${when} jesteś w biurze, siedzisz przy *${seat.label}*.`;
  return `Zapisane: ${when} jesteś w biurze, ale nie ma już wolnego biurka.`;
}

export async function changeDesk(user: User, date: string, label: string): Promise<string> {
  const layout = await getLayout();
  const away = (await planAwayUserIds(layout.id, date)) ?? undefined;
  const result = await reserveDesk(label, { userId: user.id }, date, { awayUserIds: away });
  if (!result.ok) return `Nie udało się zmienić biurka na ${label}: ${result.error === "taken" ? "ktoś już je zajął" : result.error}.`;
  await setPresence(user.id, date, "office", "button");
  await refreshPlan(date, { force: true });
  return `Zapisane: ${dayPhrase(date, localToday())} siedzisz przy *${result.reservation.desk.label}*.`;
}

export type SwapStart = { ok: true; message: string } | { ok: false; message: string };

export async function requestSwap(requester: User, target: User, date: string): Promise<SwapStart> {
  if (requester.id === target.id) return { ok: false, message: "Nie możesz zamienić się sam(a) ze sobą." };
  const state = await planState(date);
  const mine = seatOf(state, requester.id);
  const theirs = seatOf(state, target.id);
  if (!mine) return { ok: false, message: `Nie masz biurka na ${withWeekday(date)}, więc nie ma czym się zamienić.` };
  if (!theirs) return { ok: false, message: `${target.name ?? target.slackId} nie ma biurka na ${withWeekday(date)}.` };
  const request: SwapRequest = { date, from: requester.id, to: target.id, fromDesk: mine.deskId, toDesk: theirs.deskId };
  const text = `<@${requester.slackId}> pyta, czy zamienisz się biurkami ${dayPhrase(date, localToday())} (${withWeekday(date)}): dostałbyś/dostałabyś *${mine.label}* zamiast *${theirs.label}*.`;
  const message = swapRequestMessage(request, text);
  const sent = await dm(target.slackId, message.text, message.blocks);
  if (!sent) return { ok: false, message: `Nie udało się napisać do ${target.name ?? target.slackId}.` };
  return {
    ok: true,
    message: `Zapytałem ${target.name ?? target.slackId}, czy zamieni *${theirs.label}* na Twoje *${mine.label}*. Dam znać.`,
  };
}

export async function swapDesks(request: SwapRequest): Promise<{ ok: true; labels: [string, string] } | { ok: false; message: string }> {
  const state = await planState(request.date);
  const from = seatOf(state, request.from);
  const to = seatOf(state, request.to);
  if (!from || !to || from.deskId !== request.fromDesk || to.deskId !== request.toDesk)
    return { ok: false, message: "Plan zmienił się w międzyczasie, zamiana jest nieaktualna." };
  await db.transaction(async (tx) => {
    await tx
      .delete(deskReservations)
      .where(and(eq(deskReservations.date, request.date), inArray(deskReservations.userId, [request.from, request.to])));
    await tx
      .delete(deskReservations)
      .where(and(eq(deskReservations.date, request.date), inArray(deskReservations.deskId, [request.fromDesk, request.toDesk])));
    const rows = [
      { deskId: request.toDesk, userId: request.from },
      { deskId: request.fromDesk, userId: request.to },
    ].map((row) => ({ ...row, date: request.date, source: "manual", note: "zamiana" }));
    await tx.insert(deskReservations).values(rows);
  });
  await refreshPlan(request.date, { force: true });
  return { ok: true, labels: [to.label, from.label] };
}

async function openModal(payload: Payload, view: Record<string, unknown>): Promise<void> {
  const opened = await post("views.open", { trigger_id: payload.trigger_id, view });
  if (!opened.ok) log.error(`Office.PlanActions: could not open a modal: ${opened.error}`);
}

async function openChangeModal(payload: Payload, user: User, date: string): Promise<void> {
  const state = await planState(date);
  const free = state.desks.filter((desk) => desk.status === "free" || desk.status === "owner_away" || desk.reservation?.userId === user.id);
  if (free.length === 0) {
    await tell(payload.user?.id, placeOf(payload), "Nie ma wolnych biurek na ten dzień.");
    return;
  }
  await openModal(
    payload,
    selectModal({
      callbackId: PLAN_CALLBACK.change,
      title: "Zmień biurko",
      label: `Biurko na ${withWeekday(date)}`,
      submit: "Zmień",
      options: free.map((desk) => ({
        label: desk.equipment.length > 0 ? `${desk.label} (${desk.equipment.join(", ")})` : desk.label,
        value: desk.label,
      })),
      metadata: { date, ...placeOf(payload) },
    }),
  );
}

async function openSwapModal(payload: Payload, user: User, date: string): Promise<void> {
  const state = await planState(date);
  if (!seatOf(state, user.id)) {
    await tell(payload.user?.id, placeOf(payload), "Nie masz biurka w tym planie, więc nie ma czym się zamienić.");
    return;
  }
  const options = state.desks.flatMap((desk) => {
    const userId = desk.reservation?.userId ?? (desk.status === "owner_present" ? desk.ownerUserId : null);
    return userId && userId !== user.id ? [{ label: `${desk.fullName ?? "?"} (${desk.label})`, value: userId }] : [];
  });
  if (options.length === 0) {
    await tell(payload.user?.id, placeOf(payload), "Nie ma z kim się zamienić.");
    return;
  }
  await openModal(
    payload,
    selectModal({
      callbackId: PLAN_CALLBACK.swap,
      title: "Zamień się",
      label: `Z kim zamienisz się ${withWeekday(date)}?`,
      submit: "Zapytaj",
      options,
      metadata: { date, ...placeOf(payload) },
    }),
  );
}

async function prepareFromHeadsUp(payload: Payload, user: User, date: string): Promise<void> {
  const posted = await postPlan(date);
  const original = payload.message?.text ?? "";
  if (!posted.ok) {
    await tell(user.slackId, placeOf(payload), `Nie udało się przygotować planu: ${posted.error}`);
    return;
  }
  const link = posted.permalink ? ` <${posted.permalink}|Plan biurek>` : "";
  if (payload.channel?.id && payload.message?.ts)
    await post("chat.update", {
      channel: payload.channel.id,
      ts: payload.message.ts,
      ...closedMessage(original, `:white_check_mark: <@${user.slackId}> poprosił(a) o plan.${link}`),
    });
}

async function declineHeadsUp(payload: Payload, user: User, date: string): Promise<void> {
  const layout = await getLayout();
  const plan = await getPlan(layout.id, date);
  if (plan && plan.status !== "heads_up") {
    await tell(
      user.slackId,
      placeOf(payload),
      plan.status === "posted" ? "Plan na ten dzień jest już opublikowany." : "Już ustalone, że planu nie trzeba.",
    );
    return;
  }
  await updatePlan(layout.id, date, { status: "declined" });
  if (payload.channel?.id && payload.message?.ts)
    await post("chat.update", {
      channel: payload.channel.id,
      ts: payload.message.ts,
      ...closedMessage(payload.message?.text ?? "", `<@${user.slackId}>: planu nie trzeba, nie przygotuję go automatycznie.`),
    });
}

async function answerSwap(payload: Payload, user: User, accept: boolean): Promise<void> {
  const request = decodeSwap(payload.actions?.[0]?.value);
  if (!request) return;
  if (request.to !== user.id) {
    await tell(user.slackId, placeOf(payload), "Ta prośba nie jest do Ciebie.");
    return;
  }
  const requester = await getUser(request.from);
  const close = (note: string) =>
    payload.channel?.id && payload.message?.ts
      ? post("chat.update", { channel: payload.channel.id, ts: payload.message.ts, ...closedMessage(payload.message?.text ?? "", note) })
      : null;
  if (!accept) {
    await close("Odmówione.");
    if (requester)
      await dm(requester.slackId, `${user.name ?? user.slackId} nie chce się zamienić biurkami (${withWeekday(request.date)}).`);
    return;
  }
  const swapped = await swapDesks(request);
  if (!swapped.ok) {
    await close(swapped.message);
    return;
  }
  await close(`:white_check_mark: Zamienione: siedzisz przy *${swapped.labels[1]}*.`);
  if (requester)
    await dm(
      requester.slackId,
      `${user.name ?? user.slackId} zgodził(a) się: ${withWeekday(request.date)} siedzisz przy *${swapped.labels[0]}*.`,
    );
}

export async function handlePlanAction(payload: Payload): Promise<void> {
  const actionId = payload.actions?.[0]?.action_id as string;
  const user = await getUserBySlackId(payload.user?.id);
  if (!user) {
    await tell(payload.user?.id, placeOf(payload), "Nie znam Cię jeszcze, napisz do mnie najpierw.");
    return;
  }
  if (actionId === PLAN_ACTION.swapAccept || actionId === PLAN_ACTION.swapDecline)
    return answerSwap(payload, user, actionId === PLAN_ACTION.swapAccept);
  const date = dateOf(payload);
  if (!date) return;
  switch (actionId) {
    case PLAN_ACTION.away:
      return tell(user.slackId, placeOf(payload), await markAway(user, date));
    case PLAN_ACTION.coming:
      return tell(user.slackId, placeOf(payload), await markComing(user, date));
    case PLAN_ACTION.change:
      return openChangeModal(payload, user, date);
    case PLAN_ACTION.swap:
      return openSwapModal(payload, user, date);
    case PLAN_ACTION.prepare:
      return prepareFromHeadsUp(payload, user, date);
    case PLAN_ACTION.skip:
      return declineHeadsUp(payload, user, date);
  }
}

export async function handlePlanSubmission(payload: Payload): Promise<void> {
  const user = await getUserBySlackId(payload.user?.id);
  let meta: { date?: string; channel?: string | null; threadTs?: string | null };
  try {
    meta = JSON.parse(payload.view?.private_metadata ?? "{}");
  } catch {
    return;
  }
  const place = { channel: meta.channel ?? null, threadTs: meta.threadTs ?? null };
  const value = selectedValue(payload);
  if (!user || !isValidIsoDate(meta.date) || !value) return;
  if (payload.view?.callback_id === PLAN_CALLBACK.change) {
    await tell(user.slackId, place, await changeDesk(user, meta.date, value));
    return;
  }
  const target = await getUser(value);
  if (!target) return;
  const started = await requestSwap(user, target, meta.date);
  await tell(user.slackId, place, started.message);
}
