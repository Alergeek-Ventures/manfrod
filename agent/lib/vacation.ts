import { getUser } from "../../lib/accounts.ts";

export async function userName(userId: string): Promise<string> {
  const user = await getUser(userId);
  return user?.name && user.name !== "" ? user.name : "User";
}

export async function absenceNote(userId: string, startDate: string, endDate: string, working: boolean, details?: string) {
  const dates = startDate === endDate ? startDate : `${startDate}..${endDate}`;
  const name = await userName(userId);
  const detail = details && details.trim() !== "" ? details.trim() : null;
  if (working) return detail ? `${name} pracuje poza biurem ${dates}: ${detail}` : `${name} pracuje poza biurem ${dates}`;
  return detail ? `${name} nie będzie w biurze ${dates}: ${detail}` : `${name} bierze urlop ${dates}`;
}
