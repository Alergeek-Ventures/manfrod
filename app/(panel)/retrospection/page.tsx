import Link from "next/link";
import { LiveRefresh } from "@/components/live-refresh.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { listAgentRuns, listRunEvents, type AgentRun } from "@/lib/events/store.ts";
import { serializeActivity } from "@/lib/web/activity.ts";
import { requireAdmin } from "@/lib/web/session.ts";
import { Conversation } from "./conversation.tsx";
import { formatRunDateTime, KindBadge, OutcomeBadge, runStats } from "./format.tsx";

export const dynamic = "force-dynamic";

function RunItem({ run, selected }: { run: AgentRun; selected: boolean }) {
  return (
    <Link
      href={`/retrospection?run=${encodeURIComponent(run.startedAt.toISOString())}`}
      className={cn("flex flex-col gap-1.5 rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-muted", selected && "bg-muted")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{formatRunDateTime(run.startedAt.toISOString())}</span>
        <OutcomeBadge outcome={run.outcome} durationMs={run.durationMs} />
      </div>
      <div>
        <KindBadge kind={run.kind} />
      </div>
      <span className="truncate text-xs text-muted-foreground">{run.intent}</span>
      {run.outcome === "success" && Object.keys(run.stats).length > 0 && (
        <span className="text-xs text-muted-foreground">
          {runStats(run.stats)
            .map(([label, value]) => `${label}: ${String(value)}`)
            .join(" · ")}
        </span>
      )}
    </Link>
  );
}

export default async function RetrospectionPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  await requireAdmin();
  const { run: runParam } = await searchParams;
  const runs = await listAgentRuns(7);
  const wanted = runParam ? new Date(runParam).getTime() : null;
  const selected = wanted === null ? null : (runs.find((run) => run.startedAt.getTime() === wanted) ?? null);
  const events = selected ? (await listRunEvents(selected.startedAt, selected.endedAt)).map(serializeActivity) : [];

  return (
    <div className="flex h-[calc(100svh-var(--header-height)-1rem)] min-h-0">
      <LiveRefresh types={["retrospection_started", "retrospection_completed", "retrospection_failed"]} sources={selected?.outcome === "running" ? ["retrospector", "memory"] : []} />
      <ScrollArea className="w-80 shrink-0 border-r">
        <div className="flex flex-col gap-1 p-2">
          <p className="px-3 py-2 text-xs font-medium text-muted-foreground">Runs · last 7 days</p>
          {runs.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No runs</EmptyTitle>
                <EmptyDescription>Nothing ran in the last 7 days.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            runs.map((run) => <RunItem key={run.startedAt.toISOString()} run={run} selected={selected?.startedAt.getTime() === run.startedAt.getTime()} />)
          )}
        </div>
      </ScrollArea>
      <ScrollArea className="min-w-0 flex-1">
        {selected ? (
          <Conversation
            run={{ ...selected, startedAt: selected.startedAt.toISOString(), endedAt: selected.endedAt?.toISOString() ?? null }}
            events={events}
          />
        ) : (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyTitle>Pick a run</EmptyTitle>
              <EmptyDescription>Select a run on the left to see what the retrospector did.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </ScrollArea>
    </div>
  );
}
