import { addDays, compareDates } from "../time.ts";

export const HEADS_UP_MIN_WORKDAYS = 2;
export const HEADS_UP_MAX_WORKDAYS = 5;

export type Crowding = { crowded: boolean; reasons: string[] };

export type CrowdingInput = {
  visitNotes: string[];
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
  const reasons = [
    ...input.visitNotes.map((note) => `przyjeżdża: ${note}`),
    ...(input.demand > input.supply
      ? [`${peopleCount(input.demand)} bez własnego biurka, a wolnych biurek bez właściciela jest ${input.supply}`]
      : []),
    ...(input.expectedInOffice >= input.threshold ? [`~${peopleCount(input.expectedInOffice)} w biurze (próg: ${input.threshold})`] : []),
  ];
  return { crowded: reasons.length > 0, reasons };
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export const isWorkday = (date: string, holidays: ReadonlySet<string>) => weekday(date) !== 0 && weekday(date) !== 6 && !holidays.has(date);

export function workdaysAfter(today: string, count: number, holidays: ReadonlySet<string>): string[] {
  const days: string[] = [];
  for (let date = addDays(today, 1); days.length < count; date = addDays(date, 1)) if (isWorkday(date, holidays)) days.push(date);
  return days;
}

export const nextWorkday = (today: string, holidays: ReadonlySet<string>) => workdaysAfter(today, 1, holidays)[0];

export type VisitRange = { startsOn: string; endsOn: string };

export function headsUpDates(
  today: string,
  visits: VisitRange[],
  plannedDates: ReadonlySet<string>,
  holidays: ReadonlySet<string>,
): string[] {
  const window = workdaysAfter(today, HEADS_UP_MAX_WORKDAYS, holidays).slice(HEADS_UP_MIN_WORKDAYS - 1);
  return window.filter(
    (date) =>
      !plannedDates.has(date) && visits.some((visit) => compareDates(visit.startsOn, date) <= 0 && compareDates(visit.endsOn, date) >= 0),
  );
}

export type CronAction = "post" | "refresh" | "skip";

export function planCronAction(status: string | null, crowded: boolean): CronAction {
  if (status === "declined") return "skip";
  if (status === "posted") return "refresh";
  return crowded ? "post" : "skip";
}

const ON_DAY = ["w niedzielę", "w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę"];

const shortDate = (date: string) => `${Number(date.slice(8, 10))}.${date.slice(5, 7)}`;

export function dayPhrase(date: string, today: string): string {
  if (date === addDays(today, 1)) return "jutro";
  if (date === today) return "dziś";
  const days = (Date.parse(date) - Date.parse(today)) / 86_400_000;
  return days > 0 && days < 7 ? ON_DAY[weekday(date)] : `${ON_DAY[weekday(date)]} ${shortDate(date)}`;
}

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function fallbackIntro(date: string, today: string, expected: number, visitNotes: string[]): string {
  const visits = visitNotes.length > 0 ? `, przyjeżdża: ${visitNotes.join(", ")}` : "";
  return `${capitalize(dayPhrase(date, today))} ~${peopleCount(expected)} w biurze${visits}. Plan biurek poniżej.`;
}

export function headsUpText(date: string, today: string, expected: number, visitNotes: string[]): string {
  const visits = visitNotes.length > 0 ? ` (przyjeżdża: ${visitNotes.join(", ")})` : "";
  return `${capitalize(dayPhrase(date, today))} ~${peopleCount(expected)}${visits}. Przygotować plan biurek?`;
}

export const planTitle = (date: string) => `Plan biurek — ${ON_DAY[weekday(date)].replace(/^we? /, "")} ${shortDate(date)}`;
