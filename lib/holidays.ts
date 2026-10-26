import { isSystemUser, listUsers } from "./accounts.ts";
import { config } from "./config.ts";
import { getFact, overlappingAbsences, setFact } from "./facts.ts";
import { isEnabled } from "./nudges/store.ts";
import { listPublicHolidays } from "./google.ts";
import { logger } from "./log.ts";
import { deliverProactive } from "./proactive.ts";
import { addDays, localToday } from "./time.ts";

export const ASK_DAYS_AHEAD = 14;
export const RECHECK_DAYS = 3;
const GROUP_GAP_DAYS = 4;
const EDGE_BRIDGE_DAYS = 2;
const LOOKBEHIND_DAYS = 7;
const LOOKAHEAD_DAYS = ASK_DAYS_AHEAD + 21;
const WEEKDAYS = ["nd.", "pon.", "wt.", "śr.", "czw.", "pt.", "sob."];

const log = logger("HolidayCheck");

export interface Holiday {
  date: string;
  name: string;
}

export interface Bridge {
  days: string[];
  offFrom: string;
  offTo: string;
}

export interface Period {
  start: string;
  end: string;
  holidays: Holiday[];
  bridges: Bridge[];
}

export type HolidayAction = "ask" | "reask";

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const isWeekend = (date: string) => weekday(date) === 0 || weekday(date) === 6;
const dayCount = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
const short = (date: string) => `${Number(date.slice(8, 10))}.${date.slice(5, 7)}`;
const label = (date: string) => `${WEEKDAYS[weekday(date)]} ${short(date)}`;

export const planKey = (userId: string, period: string) => `holiday-plan:${userId}:${period}`;

export function holidayPeriods(holidays: Holiday[]): Period[] {
  const names = new Map<string, string>();
  for (const holiday of holidays) if (!names.has(holiday.date)) names.set(holiday.date, holiday.name);
  const off = (date: string, extra: Set<string> = new Set()) => isWeekend(date) || names.has(date) || extra.has(date);

  const breaks: { start: string; end: string }[] = [];
  for (const date of [...names.keys()].sort()) {
    if (isWeekend(date) || breaks.some((entry) => date >= entry.start && date <= entry.end)) continue;
    let start = date;
    while (off(addDays(start, -1))) start = addDays(start, -1);
    let end = date;
    while (off(addDays(end, 1))) end = addDays(end, 1);
    breaks.push({ start, end });
  }

  const workingBetween = (from: string, to: string) => {
    const days: string[] = [];
    for (let date = addDays(from, 1); date < to; date = addDays(date, 1)) if (!off(date)) days.push(date);
    return days;
  };

  const groups: { start: string; end: string; gaps: string[][] }[] = [];
  for (const entry of breaks) {
    const last = groups.at(-1);
    const gap = last ? workingBetween(last.end, entry.start) : [];
    if (last && gap.length <= GROUP_GAP_DAYS) {
      last.gaps.push(gap);
      last.end = entry.end;
    } else {
      groups.push({ ...entry, gaps: [] });
    }
  }

  const spanWith = (days: string[]): Bridge => {
    const extra = new Set(days);
    let offFrom = days[0];
    while (off(addDays(offFrom, -1), extra)) offFrom = addDays(offFrom, -1);
    let offTo = days.at(-1)!;
    while (off(addDays(offTo, 1), extra)) offTo = addDays(offTo, 1);
    return { days, offFrom, offTo };
  };

  const edge = (from: string, step: 1 | -1) => {
    const days: string[] = [];
    let date = addDays(from, step);
    while (!off(date) && days.length <= EDGE_BRIDGE_DAYS) {
      days.push(date);
      date = addDays(date, step);
    }
    return days.length > 0 && days.length <= EDGE_BRIDGE_DAYS ? days.sort() : null;
  };

  return groups.map((group) => {
    const bridges = group.gaps.map(spanWith);
    if (group.gaps.length > 1) bridges.push(spanWith(group.gaps.flat()));
    const before = edge(group.start, -1);
    if (before) bridges.unshift(spanWith(before));
    const after = edge(group.end, 1);
    if (after) bridges.push(spanWith(after));
    const holidaysInPeriod = [...names.entries()]
      .filter(([date]) => date >= group.start && date <= group.end)
      .map(([date, name]) => ({ date, name }));
    return { start: group.start, end: group.end, holidays: holidaysInPeriod, bridges };
  });
}

export function askBy(period: Period): string {
  const firstWorkday = period.holidays.find((holiday) => !isWeekend(holiday.date))?.date ?? period.start;
  return [firstWorkday, ...period.bridges.map((bridge) => bridge.days[0])].sort()[0];
}

export function nextAction(plan: string | null, today: string, deadline: string): HolidayAction | null {
  if (today >= deadline) return null;
  if (plan === null) return today >= addDays(deadline, -ASK_DAYS_AHEAD) ? "ask" : null;
  const unsure = /^unsure:(\d{4}-\d{2}-\d{2})/.exec(plan);
  return unsure && today >= unsure[1] ? "reask" : null;
}

export function unsurePlan(current: string | null, today: string, deadline: string): string {
  const recheck = addDays(today, RECHECK_DAYS);
  return current?.startsWith("reasked:") || recheck >= deadline ? "unsure" : `unsure:${recheck}`;
}

export function describePeriod(period: Period): string {
  const lines = period.holidays.map((holiday) => `• ${label(holiday.date)}: ${holiday.name}`);
  if (period.bridges.length > 0) {
    lines.push("Dni pomostowe:");
    for (const bridge of period.bridges) {
      const leave = bridge.days.length === 1 ? label(bridge.days[0]) : `${label(bridge.days[0])} - ${label(bridge.days.at(-1)!)}`;
      const cost = bridge.days.length === 1 ? "1 dzień" : `${bridge.days.length} dni`;
      lines.push(
        `• ${leave}: ${cost} urlopu → wolne ${label(bridge.offFrom)} - ${label(bridge.offTo)} (${dayCount(bridge.offFrom, bridge.offTo)} dni)`,
      );
    }
  }
  return lines.join("\n");
}

function prompt(period: Period, action: HolidayAction): string {
  const opening =
    action === "ask"
      ? `[Proaktywnie: zbliżające się święta]\nZbliża się wolne, a ta osoba nie ma nic zapisanego na ten czas:\n${describePeriod(period)}`
      : `[Proaktywnie: przypomnienie o świętach]\nKilka dni temu ta osoba nie wiedziała jeszcze, co robi w tym czasie:\n${describePeriod(period)}`;
  const ask =
    action === "ask"
      ? `Napisz jedną krótką, ciepłą wiadomość jak pomocny asystent: przypomnij o wolnym${
          period.bridges.length > 0
            ? ", podsuń dni pomostowe (ile dni urlopu daje ile dni wolnego) i zaproponuj, że od razu zapiszesz urlop"
            : ""
        }, i zapytaj, czy w święto ma wolne, czy pracuje. Bez listy pytań i bez nadmiaru emoji.`
      : "Przypomnij się raz, jednym krótkim zdaniem, bez naciskania. Więcej o to nie zapytasz.";
  return `${opening}

${ask}

Gdy odpowie, zapisz to i nie dopytuj więcej:
- bierze urlop (np. na dni pomostowe) → report-vacation na te dni, potem record-holiday-plan(period: "${period.start}", status: "off")
- ma wolne tylko w święto → record-holiday-plan(period: "${period.start}", status: "off")
- pracuje w święto → record-holiday-plan(period: "${period.start}", status: "working")
- jeszcze nie wie → record-holiday-plan(period: "${period.start}", status: "unsure")
- nie chce dostawać takich pytań → set-proactive-preferences z kind "holidays" wyłączonym`;
}

export async function upcomingPeriods(today: string, days: number) {
  const result = await listPublicHolidays(
    config.holidayCalendarId,
    new Date(`${addDays(today, -LOOKBEHIND_DAYS)}T00:00:00Z`),
    new Date(`${addDays(today, days + 21)}T00:00:00Z`),
  );
  if (!result.ok) return result;
  const limit = addDays(today, days);
  return { ok: true as const, value: holidayPeriods(result.value).filter((period) => period.end >= today && period.start <= limit) };
}

export async function runHolidayCheck(today = localToday()): Promise<number> {
  const periods = await upcomingPeriods(today, LOOKAHEAD_DAYS);
  if (!periods.ok) {
    log.error(`HolidayCheck: could not read the holiday calendar: ${periods.error}`);
    return 0;
  }
  const people = (await listUsers()).filter((user) => !isSystemUser(user) && !user.banned && user.slackDmChannelId);
  let asked = 0;
  for (const person of people) {
    if (!(await isEnabled(person.id, "holidays"))) continue;
    for (const period of periods.value) {
      const key = planKey(person.id, period.start);
      const action = nextAction((await getFact(key, ["internal"]))?.value ?? null, today, askBy(period));
      if (!action) continue;
      const from = [period.start, ...period.bridges.map((bridge) => bridge.offFrom)].sort()[0];
      const to = [period.end, ...period.bridges.map((bridge) => bridge.offTo)].sort().at(-1)!;
      if (action === "ask" && (await overlappingAbsences(person.id, from, to)).length > 0) {
        await setFact(key, "planned", ["internal"], person.id);
        continue;
      }
      const sent = await deliverProactive(person.id, prompt(period, action), "holiday_check");
      if (!sent.ok) {
        log.warn(`HolidayCheck: could not ask ${person.id} about ${period.start}: ${sent.error}`);
        continue;
      }
      await setFact(key, `${action === "ask" ? "asked" : "reasked"}:${today}`, ["internal"], person.id);
      asked += 1;
      break;
    }
  }
  log.info(`HolidayCheck: asked ${asked} person(s) about ${periods.value.length} upcoming period(s)`);
  return asked;
}
