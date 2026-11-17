import { publicHolidayDates } from "../holidays.ts";
import { logger } from "../log.ts";
import { post } from "../slack/api.ts";
import { addDays, localToday } from "../time.ts";
import { loadOffice } from "./layout.ts";
import { evaluateDay, postPlan, refreshPlan } from "./plan.ts";
import { headsUpMessage } from "./plan-message.ts";
import { headsUpDates, headsUpText, HEADS_UP_MAX_WORKDAYS, nextWorkday, planCronAction, workdaysAfter } from "./plan-rules.ts";
import { getPlan, listPlans, savePlan } from "./plan-store.ts";
import { listVisits } from "./presence.ts";

const log = logger("Office.PlanCron");

export async function runDeskPlan(today = localToday()) {
  const office = await loadOffice();
  if (!office.layout.planChannelId) return { skipped: "no_plan_channel" };
  const date = nextWorkday(today, await publicHolidayDates(today, addDays(today, 14)));
  const plan = await getPlan(office.layout.id, date);
  if (plan?.status === "declined") return { date, action: "skip", reason: "declined" };
  if (plan?.status === "posted") {
    const refreshed = await refreshPlan(date, { today });
    return { date, action: "refresh", updated: refreshed.ok && refreshed.updated };
  }
  const evaluation = await evaluateDay(date, { today });
  const action = planCronAction(plan?.status ?? null, evaluation.crowded);
  if (action !== "post") return { date, action, expected: evaluation.expectedInOffice };
  const posted = await postPlan(date, { today, evaluation });
  return { date, action, reasons: evaluation.reasons, ok: posted.ok, ...(posted.ok ? {} : { error: posted.error }) };
}

export async function runDeskPlanHeadsUp(today = localToday()) {
  const office = await loadOffice();
  const channel = office.layout.planChannelId;
  if (!channel) return { skipped: "no_plan_channel" };
  const holidays = await publicHolidayDates(today, addDays(today, 21));
  const window = workdaysAfter(today, HEADS_UP_MAX_WORKDAYS, holidays);
  const visits = await listVisits(window[0], window.at(-1)!, { layoutId: office.layout.id });
  const planned = new Set((await listPlans(office.layout.id, window)).map((plan) => plan.date));
  const dates = headsUpDates(today, visits, planned, holidays);
  const sent: string[] = [];
  for (const date of dates) {
    const evaluation = await evaluateDay(date, { today });
    const message = headsUpMessage(date, headsUpText(date, today, evaluation.expectedInOffice, evaluation.visitNotes));
    const result = await post("chat.postMessage", { channel, ...message });
    if (!result.ok) {
      log.warn(`Office.Plan: heads-up for ${date} failed: ${result.error}`);
      continue;
    }
    await savePlan(office.layout.id, date, { status: "heads_up", channelId: channel, headsUpTs: result.body.ts as string });
    sent.push(date);
  }
  return { checked: window, sent };
}
