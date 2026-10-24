import { listUsers } from "@/lib/accounts.ts";
import { listRecentFiltered } from "@/lib/events/store.ts";
import { serializeActivity } from "@/lib/web/activity.ts";
import { requireAdmin } from "@/lib/web/session.ts";
import { ActivityClient } from "./activity-client.tsx";

export const dynamic = "force-dynamic";

const MAX_EVENTS = 200;

const parseDate = (value: string | undefined) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; source?: string; user_id?: string; all_logs?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const from = parseDate(params.from);
  const to = parseDate(params.to);
  const filtered = Boolean(from || to || params.source || params.user_id);
  const showAllLogs = params.all_logs === "1";
  const events = await listRecentFiltered(MAX_EVENTS, {
    includeAllLogs: showAllLogs,
    from,
    to,
    source: params.source ?? null,
    userId: params.user_id ?? null,
  });
  const users = (await listUsers()).map((candidate) => ({ id: candidate.id, label: candidate.name ?? candidate.slackId }));

  return (
    <ActivityClient
        initialEvents={events.map(serializeActivity)}
        users={users}
        filter={filtered ? { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, source: params.source ?? null, userId: params.user_id ?? null } : null}
        showAllLogs={showAllLogs}
        maxEvents={MAX_EVENTS}
      />
  );
}
