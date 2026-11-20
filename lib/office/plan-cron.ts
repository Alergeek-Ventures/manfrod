import { publicHolidayDates } from "../holidays.ts";
import { logger } from "../log.ts";
import { post } from "../slack/api.ts";
import { addDays, localToday } from "../time.ts";
import { loadOffice } from "./layout.ts";
import { evaluateDay, postPlan, refreshPlan } from "./plan.ts";
import { headsUpMessage } from "./plan-message.ts";
import { headsUpGroups, headsUpText, HEADS_UP_MAX_WORKDAYS, nextWorkday, planCronAction, workdaysAfter } from "./plan-rules.ts";
import { claimHeadsUp, getPlan, listPlans, releaseHeadsUp, setHeadsUpTs } from "./plan-store.ts";
import { listVisits } from "./presence.ts";

const log = logger("Office.PlanCron");

export async function runDeskPlan(today = localToday()) {
  const office = await loadOffice();
  if (!office.layout.planChannelId) return { skipped: "no_plan_channel" };
  const holidays = await publicHolidayDates(today, addDays(today, 14));
  if (!holidays) return { skipped: "no_holidays" };
  const date = nextWorkday(today, holidays);
  const plan = await getPlan(office.layout.id, date);
  if (plan?.status === "posted") {
    const refreshed = await refreshPlan(date, { today });
    return { date, action: "refresh", updated: refreshed.ok && refreshed.updated };
  }
  if (plan?.status === "posting") return { date, action: "skip", reason: "posting" };
  const evaluation = plan?.status === "requested" ? null : await evaluateDay(date, { today });
  const action = planCronAction(plan?.status ?? null, evaluation ?? { crowded: true, crowdedWithoutVisits: true });
  if (action !== "post") return { date, action, status: plan?.status ?? null, expected: evaluation?.expectedInOffice };
  const posted = await postPlan(date, { today });
  return {
    date,
    action,
    requested: plan?.status === "requested",
    reasons: evaluation?.reasons ?? [],
    ok: posted.ok,
    ...(posted.ok ? {} : { error: posted.error }),
  };
}

export async function runDeskPlanHeadsUp(today = localToday()) {
  const office = await loadOffice();
  const channel = office.layout.planChannelId;
  if (!channel) return { skipped: "no_plan_channel" };
  const holidays = await publicHolidayDates(today, addDays(today, 21));
  if (!holidays) return { skipped: "no_holidays" };
  const window = workdaysAfter(today, HEADS_UP_MAX_WORKDAYS, holidays);
  const visits = await listVisits(window[0], window.at(-1)!, { layoutId: office.layout.id });
  const planned = new Set((await listPlans(office.layout.id, window)).map((plan) => plan.date));
  const sent: string[][] = [];
  for (const group of headsUpGroups(today, visits, planned, holidays)) {
    const evaluations = await Promise.all(group.dates.map((date) => evaluateDay(date, { today })));
    if (!evaluations.some((evaluation) => evaluation.crowded)) continue;
    const dates = await claimHeadsUp(office.layout.id, group.dates, channel);
    if (dates.length === 0) continue;
    const expected = Math.max(...evaluations.map((evaluation) => evaluation.expectedInOffice));
    const lines = new Map(evaluations.flatMap((evaluation) => evaluation.visits).map((visit) => [visit.id, visit.summary]));
    const summaries = group.visitIds.flatMap((id) => lines.get(id) ?? []);
    const result = await post("chat.postMessage", { channel, ...headsUpMessage(dates, headsUpText(dates, expected, summaries)) });
    if (!result.ok) {
      log.warn(`Office.PlanCron: heads-up for ${dates.join(", ")} failed: ${result.error}`);
      await releaseHeadsUp(office.layout.id, dates);
      continue;
    }
    await setHeadsUpTs(office.layout.id, dates, result.body.ts as string);
    sent.push(dates);
  }
  return { checked: window, sent };
}
