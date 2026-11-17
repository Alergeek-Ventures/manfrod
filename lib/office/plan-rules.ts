import { addDays, compareDates } from "../time.ts";

export const HEADS_UP_MIN_WORKDAYS = 2;
export const HEADS_UP_MAX_WORKDAYS = 5;

export const VISIT_MIN_EXTRA_PEOPLE = 2;

export type Crowding = { crowded: boolean; crowdedWithoutVisits: boolean; reasons: string[] };

export type CrowdingInput = {
  visitNotes: string[];
  visitExtraPeople: number;
  demand: number;
  supply: number;
  expectedInOffice: number;
  threshold: number;
};

export function peopleCount(count: number): string {
  if (count === 1) return "1 osoba";
  const tens = count % 100;
  const ones = count % 10;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return `${count} osoby`;
  return `${count} osób`;
}

export function crowding(input: CrowdingInput): Crowding {
  const visitReasons = input.visitExtraPeople >= VISIT_MIN_EXTRA_PEOPLE ? input.visitNotes.map((note) => `przyjeżdża: ${note}`) : [];
  const otherReasons = [
    ...(input.demand > input.supply
      ? [`${peopleCount(input.demand)} bez własnego biurka, a wolnych biurek bez właściciela jest ${input.supply}`]
      : []),
    ...(input.expectedInOffice >= input.threshold ? [`~${peopleCount(input.expectedInOffice)} w biurze (próg: ${input.threshold})`] : []),
  ];
  const reasons = [...visitReasons, ...otherReasons];
  return { crowded: reasons.length > 0, crowdedWithoutVisits: otherReasons.length > 0, reasons };
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export const isWorkday = (date: string, holidays: ReadonlySet<string>) => weekday(date) !== 0 && weekday(date) !== 6 && !holidays.has(date);

export function workdaysAfter(today: string, count: number, holidays: ReadonlySet<string>): string[] {
  const days: string[] = [];
  for (let date = addDays(today, 1); days.length < count; date = addDays(date, 1)) if (isWorkday(date, holidays)) days.push(date);
  return days;
}

export const nextWorkday = (today: string, holidays: ReadonlySet<string>) => workdaysAfter(today, 1, holidays)[0];

export type VisitRange = { startsOn: string; endsOn: string; note: string };

export type HeadsUpGroup = { dates: string[]; notes: string[] };

export function headsUpGroups(
  today: string,
  visits: VisitRange[],
  plannedDates: ReadonlySet<string>,
  holidays: ReadonlySet<string>,
): HeadsUpGroup[] {
  const window = workdaysAfter(today, HEADS_UP_MAX_WORKDAYS, holidays).slice(HEADS_UP_MIN_WORKDAYS - 1);
  const taken = new Set(plannedDates);
  const groups: HeadsUpGroup[] = [];
  for (const visit of [...visits].sort((a, b) => compareDates(a.startsOn, b.startsOn))) {
    const covered = window.filter((date) => compareDates(visit.startsOn, date) <= 0 && compareDates(visit.endsOn, date) >= 0);
    if (covered.some((date) => plannedDates.has(date))) continue;
    const dates = covered.filter((date) => !taken.has(date));
    const joined = groups.find((group) => group.dates.some((date) => covered.includes(date)));
    if (joined) {
      if (!joined.notes.includes(visit.note)) joined.notes.push(visit.note);
      joined.dates = [...new Set([...joined.dates, ...dates])].sort();
    } else if (dates.length > 0) groups.push({ dates, notes: [visit.note] });
    for (const date of dates) taken.add(date);
  }
  return groups;
}

export type CronAction = "post" | "refresh" | "skip";

export function planCronAction(status: string | null, crowding: Pick<Crowding, "crowded" | "crowdedWithoutVisits">): CronAction {
  switch (status) {
    case "posted":
      return "refresh";
    case "posting":
      return "skip";
    case "requested":
      return "post";
    case "declined":
      return crowding.crowdedWithoutVisits ? "post" : "skip";
    default:
      return crowding.crowded ? "post" : "skip";
  }
}

const ON_DAY = ["w niedzielę", "w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę"];

const shortDate = (date: string) => `${Number(date.slice(8, 10))}.${date.slice(5, 7)}`;

export const dayLabel = (date: string) => `${ON_DAY[weekday(date)]} ${shortDate(date)}`;

export function daysLabel(dates: string[]): string {
  if (dates.length <= 1) return dayLabel(dates[0]);
  return `${dayLabel(dates[0])} – ${dayLabel(dates.at(-1)!).replace(/^we? /, "")}`;
}

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function fallbackIntro(date: string, expected: number, visitNotes: string[]): string {
  const visits = visitNotes.length > 0 ? `, przyjeżdża: ${visitNotes.join(", ")}` : "";
  return `${capitalize(dayLabel(date))} ~${peopleCount(expected)} w biurze${visits}. Plan biurek poniżej.`;
}

export function headsUpText(dates: string[], expected: number, visitNotes: string[]): string {
  const visits = visitNotes.length > 0 ? ` (przyjeżdża: ${visitNotes.join(", ")})` : "";
  return `${capitalize(daysLabel(dates))} ~${peopleCount(expected)}${visits}. Przygotować plan biurek?`;
}

export const planTitle = (date: string) => `Plan biurek — ${ON_DAY[weekday(date)].replace(/^we? /, "")} ${shortDate(date)}`;
