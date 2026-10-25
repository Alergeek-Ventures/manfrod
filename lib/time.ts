export const TIMEZONE = "Europe/Warsaw";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let existing = formatters.get(timeZone);
  if (!existing) {
    existing = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, existing);
  }
  return existing;
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, timeZone: string = TIMEZONE): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

export function offsetMinutes(date: Date, timeZone: string = TIMEZONE): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

export function zonedToUtc(dateIso: string, time: string, timeZone: string = TIMEZONE): Date {
  const [year, month, day] = dateIso.split("-").map(Number);
  const [hour, minute, second = 0] = time.split(":").map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let result = new Date(guess - offsetMinutes(new Date(guess), timeZone) * 60_000);
  result = new Date(guess - offsetMinutes(result, timeZone) * 60_000);
  return result;
}

export function dateIsoInZone(date: Date, timeZone: string = TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function localToday(timeZone: string = TIMEZONE): string {
  return dateIsoInZone(new Date(), timeZone);
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function weekdayName(dateIso: string): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isoWeek(dateIso: string): number {
  const [year, month, day] = dateIso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

export function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function localIsoWithOffset(date: Date, timeZone: string = TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  const offset = offsetMinutes(date, timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  const millis = pad(date.getUTCMilliseconds(), 3);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${millis}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

export function zoneAbbreviation(date: Date, timeZone: string = TIMEZONE): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName");
  const offset = offsetMinutes(date, timeZone);
  if (timeZone === "Europe/Warsaw") return offset === 120 ? "CEST" : "CET";
  return part?.value ?? timeZone;
}

export function formatLocal(date: Date, timeZone: string = TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function secondsOfDay(date: Date, timeZone: string = TIMEZONE): number {
  const parts = zonedParts(date, timeZone);
  return parts.hour * 3600 + parts.minute * 60 + parts.second;
}

export function timeFromSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function slackTsToDate(ts: string): Date {
  return new Date(Math.trunc(Number.parseFloat(ts)) * 1000);
}
