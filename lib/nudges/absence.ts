import { and, eq, inArray, isNull } from "drizzle-orm";
import { getUser } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import { listUserReservations } from "../desks.ts";
import { describePeriod, upcomingPeriods } from "../holidays.ts";
import { logger } from "../log.ts";
import { callTool, formatResult } from "../mcp/client.ts";
import { addDays, localToday } from "../time.ts";
import { run } from "./compose.ts";
import { describeMeetings, firmowidAccess, meetings } from "./signals.ts";
import { handled, isEnabled } from "./store.ts";

const { channelMappings, projectMemberships, projects } = tables;
const FIRMOWID_CHARS = 1500;
const MAX_CHANNELS = 6;

const log = logger("Nudges.Absence");

const GUIDANCE = `This person just told you about an upcoming absence and has just chosen who may see it. Offer, in one message, only the follow-ups that apply. When their Firmowid leave requests are listed and none covers these dates, always send and open by asking whether to submit the leave request to Firmowid now, with the dates and the type you would pick filled in: "rest" for vacation or a day off, "indisposition" for feeling unwell, "other" with a short note for anything else. Firmowid can't take sick leave (L4) or unpaid leave this way, so for those say they need to file it in Firmowid themselves. Then mention, briefly, the other follow-ups that apply: cancelling their desk bookings on those days, a short note in their project channels, and meetings that clash (name them and suggest letting attendees know). If a holiday sits right next to it, you may point out the long break. End warmly. If nothing applies, do not send.`;

const FOLLOW_UP = `Gdy odpowie:
- wniosek urlopowy: najpierw sprawdź firmowid__list_leave_requests dla tych dat i jeśli jakiś wniosek już je pokrywa, nie twórz drugiego, tylko o tym powiedz. Inaczej wywołaj firmowid__create_leave_request ze starts_on i ends_on z danych, reason "rest", "indisposition" albo "other" (ten, który zaproponowałeś, chyba że poprawi) i krótkim note. L4 ani urlopu bezpłatnego nie da się tak zgłosić, wtedy powiedz, że trzeba to zrobić w Firmowidzie
- biurka: cancel-desk-reservation dla każdego dnia
- kanały projektów: napisz krótką notkę i wyślij ją przez announce-absence do kanałów, które wybierze
- jeśli czegoś nie chce, przyjmij to i nie wracaj do tego`;

async function projectChannels(userId: string) {
  const memberships = await db
    .select({ projectId: projectMemberships.projectId })
    .from(projectMemberships)
    .where(and(eq(projectMemberships.userId, userId), isNull(projectMemberships.removedAt)));
  if (memberships.length === 0) return [];
  return db
    .select({ id: channelMappings.slackChannelId, name: channelMappings.slackChannelName, project: projects.name })
    .from(channelMappings)
    .innerJoin(projects, eq(projects.id, channelMappings.projectId))
    .where(
      and(
        eq(channelMappings.status, "active"),
        inArray(
          channelMappings.projectId,
          memberships.map((row) => row.projectId),
        ),
      ),
    )
    .limit(MAX_CHANNELS);
}

async function leaveRequests(userId: string, startDate: string, endDate: string): Promise<string | null> {
  const access = await firmowidAccess(userId);
  if (!access) return null;
  const result = await callTool(access.mcpUrl, access.token, "list_leave_requests", { start_date: startDate, end_date: endDate });
  if (!result.ok) return null;
  const text = formatResult(result.value);
  return text.length > FIRMOWID_CHARS ? `${text.slice(0, FIRMOWID_CHARS)}…` : text;
}

export async function runAbsenceFollowUp(
  userId: string,
  startDate: string,
  endDate: string,
  working: boolean,
  details?: string,
): Promise<boolean> {
  const person = await getUser(userId);
  const period = `${startDate}..${endDate}`;
  if (!person?.slackDmChannelId || endDate < localToday()) return false;
  if (!(await isEnabled(userId, "absence")) || (await handled(userId, "absence", period))) return false;
  try {
    const requests = working ? null : await leaveRequests(userId, startDate, endDate);
    const desks = (await listUserReservations(userId)).filter((row) => row.date >= startDate && row.date <= endDate);
    const calendar = await meetings(userId, startDate, addDays(endDate, 1));
    const channels = await projectChannels(userId);
    const span = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 8;
    const holidays = await upcomingPeriods(addDays(startDate, -4), span);
    const nearby = holidays.ok ? holidays.value : [];
    const context = [
      `Absence: ${period}${working ? " (working away from the office, not time off)" : ""}`,
      details ? `How they described it: ${details}` : "",
      requests !== null ? `Their Firmowid leave requests for these dates:\n${requests}` : "",
      desks.length > 0 ? `Their desk bookings on those days:\n${desks.map((row) => `- ${row.date}: ${row.desk.label}`).join("\n")}` : "",
      calendar && calendar.length > 0 ? `Their meetings on those days:\n${describeMeetings(calendar)}` : "",
      channels.length > 0
        ? `Their project channels:\n${channels.map((channel) => `- <#${channel.id}> (${channel.project ?? channel.name ?? channel.id})`).join("\n")}`
        : "",
      nearby.length > 0 ? `Public holidays nearby:\n${nearby.map(describePeriod).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return await run({ kind: "absence", period, person, guidance: GUIDANCE, context, followUp: FOLLOW_UP });
  } catch (error) {
    log.error(`Nudges.Absence: failed for ${userId}: ${(error as Error).message}`);
    return false;
  }
}
