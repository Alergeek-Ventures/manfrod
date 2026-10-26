import { getUser } from "../accounts.ts";
import type { User } from "../db/schema.ts";
import { listFacts, parseDateRange } from "../facts.ts";
import { averageTimeOfDay, fetchRecentSessions } from "../firmowid.ts";
import { listUserReservations } from "../desks.ts";
import { describePeriod, upcomingPeriods } from "../holidays.ts";
import { logger } from "../log.ts";
import { addDays, dateIsoInZone, isoWeek, localToday, secondsOfDay } from "../time.ts";
import { run } from "./compose.ts";
import { describeMeetings, firmowidAccess, isAbsent, meetings, nudgeablePeople } from "./signals.ts";
import { handled, isEnabled, recordDelivery } from "./store.ts";

const DEFAULT_SEND_AT = 15 * 3600;
const EARLIEST_SEND_AT = 13 * 3600;
const BEFORE_END_SECONDS = 90 * 60;
const SESSION_SAMPLE = 80;

const log = logger("Nudges.Weekly");

const GUIDANCE = `It is Friday afternoon. Write a short wrap-up of this person's week and a look at the next one. Useful: hours logged in Firmowid this week, workdays with no session (offer to add them), and what is notable next week: a holiday or long weekend, their own leave, a day packed with meetings, colleagues away that matter to them, desk bookings. Mention only what is there. If there is nothing worth saying, do not send.`;

const FOLLOW_UP = `Gdy odpowie: jeśli chce uzupełnić godziny, użyj narzędzi firmowid__* (najpierw dopytaj o brakujące szczegóły). Jeśli chce zarezerwować biurko albo zgłosić urlop, użyj zwykłych narzędzi.`;

export interface DayLog {
  date: string;
  minutes: number;
  titles: string[];
}

export function weekLog(sessions: Record<string, any>[], monday: string, today: string, now = Date.now()): DayLog[] {
  const days = new Map<string, DayLog>();
  for (let date = monday; date <= today; date = addDays(date, 1)) days.set(date, { date, minutes: 0, titles: [] });
  for (const session of sessions) {
    if (typeof session.start_datetime !== "string") continue;
    const start = new Date(session.start_datetime);
    const day = days.get(dateIsoInZone(start));
    if (!day) continue;
    const end = typeof session.end_datetime === "string" ? new Date(session.end_datetime).getTime() : now;
    day.minutes += Math.max(Math.round((end - start.getTime()) / 60_000), 0);
    if (typeof session.title === "string" && !day.titles.includes(session.title)) day.titles.push(session.title);
  }
  return [...days.values()];
}

function mondayOf(today: string): string {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, -((weekday + 6) % 7));
}

async function firmowidPart(person: User, monday: string, today: string, offDays: Set<string>) {
  const access = await firmowidAccess(person.id);
  if (!access) return { text: "", sendAt: DEFAULT_SEND_AT };
  const sessions = await fetchRecentSessions(access.mcpUrl, access.token, SESSION_SAMPLE);
  if (!sessions.ok) return { text: "", sendAt: DEFAULT_SEND_AT };
  const end = averageTimeOfDay(sessions.value, today, "end_datetime", "max");
  const [hours, minutes] = (end ?? "").split(":").map(Number);
  const sendAt = end ? Math.max(hours * 3600 + minutes * 60 - BEFORE_END_SECONDS, EARLIEST_SEND_AT) : DEFAULT_SEND_AT;
  const lines = weekLog(sessions.value, monday, today)
    .filter((day) => !offDays.has(day.date))
    .map((day) =>
      day.minutes === 0
        ? `- ${day.date}: no session`
        : `- ${day.date}: ${Math.floor(day.minutes / 60)}h ${day.minutes % 60}min (${day.titles.join("; ")})`,
    );
  return { text: `Firmowid sessions this week:\n${lines.join("\n")}`, sendAt };
}

async function absencesBetween(from: string, to: string) {
  const rows: { userId: string | null; value: string }[] = [];
  for (const fact of await listFacts("absence:", ["internal"])) {
    const range = parseDateRange(fact.value);
    if (range && range.from <= to && range.to >= from) rows.push({ userId: fact.setByUserId, value: fact.value });
  }
  return rows;
}

export async function runWeeklyWrapUps(today = localToday()): Promise<number> {
  const monday = mondayOf(today);
  const nextMonday = addDays(monday, 7);
  const nextFriday = addDays(nextMonday, 4);
  const period = `${today.slice(0, 4)}-W${String(isoWeek(today)).padStart(2, "0")}`;
  const nowSeconds = secondsOfDay(new Date());
  const holidays = await upcomingPeriods(monday, 14);
  const periods = holidays.ok ? holidays.value : [];
  const holidayDays = new Set(periods.flatMap((entry) => entry.holidays.map((holiday) => holiday.date)));
  const away = await absencesBetween(nextMonday, nextFriday);
  let sent = 0;
  for (const person of await nudgeablePeople()) {
    try {
      if (!(await isEnabled(person.id, "weekly")) || (await handled(person.id, "weekly", period))) continue;
      if (await isAbsent(person.id, today)) {
        await recordDelivery(person.id, "weekly", period, false, "Absent today.");
        continue;
      }
      const ownAbsences = await absencesBetween(monday, nextFriday).then((rows) => rows.filter((row) => row.userId === person.id));
      const offDays = new Set(holidayDays);
      for (const row of ownAbsences) {
        const range = parseDateRange(row.value)!;
        for (let date = range.from; date <= range.to; date = addDays(date, 1)) offDays.add(date);
      }
      const firmowid = await firmowidPart(person, monday, today, offDays);
      if (nowSeconds < firmowid.sendAt) continue;

      const nextWeek = periods.filter((entry) => entry.end >= nextMonday && entry.start <= nextFriday);
      const desks = (await listUserReservations(person.id)).filter((row) => row.date >= nextMonday && row.date <= nextFriday);
      const calendar = await meetings(person.id, nextMonday, addDays(nextFriday, 1));
      const colleagues = await Promise.all(
        away
          .filter((row) => row.userId && row.userId !== person.id)
          .map(async (row) => `- ${(await getUser(row.userId!))?.name ?? "?"}: ${row.value}`),
      );
      const context = [
        firmowid.text,
        ownAbsences.length > 0 ? `Their own absences:\n${ownAbsences.map((row) => `- ${row.value}`).join("\n")}` : "",
        nextWeek.length > 0 ? `Public holidays next week:\n${nextWeek.map(describePeriod).join("\n")}` : "",
        calendar && calendar.length > 0 ? `Their meetings next week:\n${describeMeetings(calendar)}` : "",
        desks.length > 0 ? `Their desk bookings next week:\n${desks.map((row) => `- ${row.date}: ${row.desk.label}`).join("\n")}` : "",
        colleagues.length > 0 ? `Colleagues away next week:\n${colleagues.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (!context) {
        await recordDelivery(person.id, "weekly", period, false, "Nothing to report.");
        continue;
      }
      if (await run({ kind: "weekly", period, person, guidance: GUIDANCE, context, followUp: FOLLOW_UP })) sent += 1;
    } catch (error) {
      log.error(`Nudges.Weekly: failed for ${person.id}: ${(error as Error).message}`);
    }
  }
  if (sent > 0) log.info(`Nudges.Weekly: sent ${sent} wrap-up(s)`);
  return sent;
}
