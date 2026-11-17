import { and, eq, inArray } from "drizzle-orm";
import { getUser, getUserBySlackId } from "../accounts.ts";
import { tables } from "../db/index.ts";
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
  loadingModal,
  noticeModal,
  parseDates,
  PLAN_ACTION,
  PLAN_CALLBACK,
  selectedValue,
  selectModal,
  swapRequestMessage,
  type SwapRequest,
} from "./plan-message.ts";
import { dayLabel } from "./plan-rules.ts";
import { planAwayUserIds, setUnpostedStatus, withPlanLock } from "./plan-store.ts";
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
  return `Zapisane: ${dayLabel(date)} nie będzie Cię w biurze.${desk}`;
}

export async function markComing(user: User, date: string): Promise<string> {
  await setPresence(user.id, date, "office", "button");
  const refreshed = await refreshPlan(date, { force: true });
  const seat = refreshed.ok ? refreshed.prepared?.result.assignments.find((assignment) => assignment.userId === user.id) : undefined;
  const when = dayLabel(date);
  if (seat) return `Zapisane: ${when} jesteś w biurze, siedzisz przy *${seat.label}*.`;
  if (!refreshed.ok || !refreshed.prepared) return `Zapisane: ${when} jesteś w biurze.`;
  return `Zapisane: ${when} jesteś w biurze, ale nie ma już wolnego biurka.`;
}

export async function changeDesk(user: User, date: string, label: string): Promise<string> {
  const layout = await getLayout();
  const away = (await planAwayUserIds(layout.id, date)) ?? undefined;
  const result = await reserveDesk(label, { userId: user.id }, date, { awayUserIds: away });
  if (!result.ok) return `Nie udało się zmienić biurka na ${label}: ${result.error === "taken" ? "ktoś już je zajął" : result.error}.`;
  await setPresence(user.id, date, "office", "button");
  await refreshPlan(date, { force: true });
  return `Zapisane: ${dayLabel(date)} siedzisz przy *${result.reservation.desk.label}*.`;
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
  const text = `<@${requester.slackId}> pyta, czy zamienisz się biurkami ${dayLabel(date)} (${withWeekday(date)}): dostałbyś/dostałabyś *${mine.label}* zamiast *${theirs.label}*.`;
  const message = swapRequestMessage(request, text);
  const sent = await dm(target.slackId, message.text, message.blocks);
  if (!sent) return { ok: false, message: `Nie udało się napisać do ${target.name ?? target.slackId}.` };
  return {
    ok: true,
    message: `Zapytałem ${target.name ?? target.slackId}, czy zamieni *${theirs.label}* na Twoje *${mine.label}*. Dam znać.`,
  };
}

type SwapOutcome = { ok: true; labels: [string, string] } | { ok: false; message: string };

export async function swapDesks(request: SwapRequest): Promise<SwapOutcome> {
  const layout = await getLayout();
  const outcome = await withPlanLock(layout.id, request.date, async (tx): Promise<SwapOutcome> => {
    const state = await planState(request.date);
    const from = seatOf(state, request.from);
    const to = seatOf(state, request.to);
    if (!from || !to || from.deskId !== request.fromDesk || to.deskId !== request.toDesk)
      return { ok: false, message: "Plan zmienił się w międzyczasie, zamiana jest nieaktualna." };
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
    return { ok: true, labels: [to.label, from.label] };
  });
  if (outcome.ok) await refreshPlan(request.date, { force: true });
  return outcome;
}

const LOADING_CALLBACK = "desk_plan_loading";

type ModalBuild = { view: Record<string, unknown> } | { notice: string };

async function openModalFast(payload: Payload, title: string, build: () => Promise<ModalBuild>): Promise<void> {
  const opened = await post("views.open", { trigger_id: payload.trigger_id, view: loadingModal(LOADING_CALLBACK, title) });
  if (!opened.ok) {
    log.warn(`Office.PlanActions: could not open a modal: ${opened.error}`);
    await tell(payload.user?.id, placeOf(payload), "Nie udało się otworzyć okna, spróbuj jeszcze raz.");
    return;
  }
  const viewId = opened.body.view?.id as string | undefined;
  const built = await build().catch((error): ModalBuild => {
    log.error(`Office.PlanActions: building a modal failed: ${(error as Error).message}`);
    return { notice: "Coś poszło nie tak, spróbuj jeszcze raz." };
  });
  const view = "view" in built ? built.view : noticeModal(LOADING_CALLBACK, title, built.notice);
  const updated = await post("views.update", { view_id: viewId, view });
  if (!updated.ok) log.warn(`Office.PlanActions: could not update a modal: ${updated.error}`);
}

async function changeModal(payload: Payload, user: User, date: string): Promise<ModalBuild> {
  const state = await planState(date);
  const free = state.desks.filter((desk) => desk.status === "free" || desk.status === "owner_away" || desk.reservation?.userId === user.id);
  if (free.length === 0) return { notice: "Nie ma wolnych biurek na ten dzień." };
  return {
    view: selectModal({
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
  };
}

async function swapModal(payload: Payload, user: User, date: string): Promise<ModalBuild> {
  const state = await planState(date);
  if (!seatOf(state, user.id)) return { notice: "Nie masz biurka w tym planie, więc nie ma czym się zamienić." };
  const options = state.desks.flatMap((desk) => {
    const userId = desk.reservation?.userId ?? (desk.status === "owner_present" ? desk.ownerUserId : null);
    return userId && userId !== user.id ? [{ label: `${desk.fullName ?? "?"} (${desk.label})`, value: userId }] : [];
  });
  if (options.length === 0) return { notice: "Nie ma z kim się zamienić." };
  return {
    view: selectModal({
      callbackId: PLAN_CALLBACK.swap,
      title: "Zamień się",
      label: `Z kim zamienisz się ${withWeekday(date)}?`,
      submit: "Zapytaj",
      options,
      metadata: { date, ...placeOf(payload) },
    }),
  };
}

async function closeHeadsUp(payload: Payload, note: string): Promise<void> {
  if (payload.channel?.id && payload.message?.ts)
    await post("chat.update", { channel: payload.channel.id, ts: payload.message.ts, ...closedMessage(payload.message?.text ?? "", note) });
}

export async function prepareFromHeadsUp(payload: Payload, user: User, dates: string[]): Promise<void> {
  const today = localToday();
  const upcoming = dates.filter((date) => date >= today);
  if (upcoming.length === 0) {
    await tell(user.slackId, placeOf(payload), "Ten dzień już minął.");
    return;
  }
  const layout = await getLayout();
  await setUnpostedStatus(layout.id, upcoming, "requested");
  const posted = await postPlan(upcoming[0], { today });
  if (!posted.ok) {
    await tell(user.slackId, placeOf(payload), `Nie udało się przygotować planu: ${posted.error}`);
    return;
  }
  const link = posted.permalink ? ` <${posted.permalink}|Plan na ${dayLabel(upcoming[0])}>` : "";
  const later = upcoming.slice(1);
  const rest = later.length > 0 ? ` Plany na ${later.map(dayLabel).join(", ")} wrzucę dzień wcześniej po południu.` : "";
  await closeHeadsUp(payload, `:white_check_mark: <@${user.slackId}> poprosił(a) o plan.${link}${rest}`);
}

export async function declineHeadsUp(payload: Payload, user: User, dates: string[]): Promise<void> {
  const layout = await getLayout();
  const declined = await setUnpostedStatus(layout.id, dates, "declined");
  if (declined.length === 0) {
    await tell(user.slackId, placeOf(payload), "Plan na ten dzień jest już opublikowany albo w przygotowaniu.");
    return;
  }
  await closeHeadsUp(
    payload,
    `<@${user.slackId}>: planu nie trzeba. Wrzucę go tylko, jeśli w biurze i tak zrobi się ciasno (${declined.map(dayLabel).join(", ")}).`,
  );
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

const MODAL_TITLES: Record<string, string> = { [PLAN_ACTION.change]: "Zmień biurko", [PLAN_ACTION.swap]: "Zamień się" };

export async function handlePlanAction(payload: Payload): Promise<void> {
  const actionId = payload.actions?.[0]?.action_id as string;
  if (actionId in MODAL_TITLES) {
    await openModalFast(payload, MODAL_TITLES[actionId], async () => {
      const user = await getUserBySlackId(payload.user?.id);
      const date = dateOf(payload);
      if (!user || !date) return { notice: "Nie znam Cię jeszcze, napisz do mnie najpierw." };
      return actionId === PLAN_ACTION.change ? changeModal(payload, user, date) : swapModal(payload, user, date);
    });
    return;
  }
  const user = await getUserBySlackId(payload.user?.id);
  if (!user) {
    await tell(payload.user?.id, placeOf(payload), "Nie znam Cię jeszcze, napisz do mnie najpierw.");
    return;
  }
  if (actionId === PLAN_ACTION.swapAccept || actionId === PLAN_ACTION.swapDecline)
    return answerSwap(payload, user, actionId === PLAN_ACTION.swapAccept);
  if (actionId === PLAN_ACTION.prepare) return prepareFromHeadsUp(payload, user, parseDates(payload.actions?.[0]?.value));
  if (actionId === PLAN_ACTION.skip) return declineHeadsUp(payload, user, parseDates(payload.actions?.[0]?.value));
  const date = dateOf(payload);
  if (!date) return;
  if (date < localToday()) {
    await tell(user.slackId, placeOf(payload), "Ten dzień już minął.");
    return;
  }
  switch (actionId) {
    case PLAN_ACTION.away:
      return tell(user.slackId, placeOf(payload), await markAway(user, date));
    case PLAN_ACTION.coming:
      return tell(user.slackId, placeOf(payload), await markComing(user, date));
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
