import { cancelReservationsForDate } from "../desks.ts";
import { localToday } from "../time.ts";
import { refreshPlans } from "./plan.ts";
import type { StatedStatus } from "./presence-resolve.ts";
import { setChatPresence } from "./presence-store.ts";

export async function releaseAwayDays(userId: string, dates: string[], today = localToday()): Promise<string[]> {
  const upcoming = dates.filter((date) => date >= today);
  for (const date of upcoming) await cancelReservationsForDate(userId, date);
  return refreshPlans(upcoming);
}

export async function recordChatPresence(userId: string, dates: string[], status: StatedStatus, today = localToday()): Promise<string[]> {
  const recorded: string[] = [];
  for (const date of dates.filter((day) => day >= today)) if (await setChatPresence(userId, date, status)) recorded.push(date);
  return recorded.length > 0 ? refreshPlans(recorded) : [];
}
