"use client";

import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { ActivityView } from "@/components/activity-format.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { formatDuration, formatRunDateTime, KindBadge, OutcomeBadge, type RunView } from "./format.tsx";

interface ToolCall {
  actionId: string;
  action: string;
  args: unknown;
  result: string | null;
  durationMs: number | null;
  success: boolean | null;
  timestamp: string;
}

interface Turn {
  iteration: number;
  narrative: ActivityView | undefined;
  toolCalls: ToolCall[];
  memoryEvents: ActivityView[];
  final: boolean;
}

const MEMORY_TYPES = new Set([
  "memory_node_created",
  "memory_node_updated",
  "memory_node_deleted",
  "memory_link_created",
  "memory_link_deleted",
  "memory_node_processed",
  "memory_searched",
]);

function groupIntoTurns(events: ActivityView[]): Turn[] {
  const groups = new Map<number, ActivityView[]>();
  for (const event of events) {
    const iteration = typeof event.meta.iteration === "number" ? event.meta.iteration : -1;
    groups.set(iteration, [...(groups.get(iteration) ?? []), event]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a - b)
    .map(([iteration, turnEvents]) => {
      const narrative = turnEvents.find((event) => event.type === "narrating");
      const completions = new Map(
        turnEvents.filter((event) => event.type === "action_completed").map((event) => [event.meta.action_id, event]),
      );
      const toolCalls = turnEvents
        .filter((event) => event.type === "action_started")
        .map((start) => {
          const completion = completions.get(start.meta.action_id);
          return {
            actionId: start.meta.action_id,
            action: start.meta.action,
            args: start.meta.args,
            result: completion?.meta.result ?? null,
            durationMs: completion?.meta.duration_ms ?? null,
            success: completion ? completion.meta.success : null,
            timestamp: start.timestamp,
          };
        })
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return {
        iteration,
        narrative,
        toolCalls,
        memoryEvents: turnEvents.filter((event) => MEMORY_TYPES.has(event.type)),
        final: narrative?.meta.final === true,
      };
    })
    .filter((turn) => turn.narrative || turn.toolCalls.length > 0 || turn.memoryEvents.length > 0);
}

function decodeArgs(args: unknown): Record<string, any> | null {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return args && typeof args === "object" ? (args as Record<string, any>) : null;
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

function summary(call: ToolCall): string {
  const args = decodeArgs(call.args) ?? {};
  switch (call.action) {
    case "search":
    case "web_search":
      return args.query ? `"${truncate(String(args.query), 40)}"` : "";
    case "create_node":
      return args.content ? `"${truncate(String(args.content), 40)}"` : "";
    case "create_link":
      return args.node_a_id && args.node_b_id ? `${truncate(args.node_a_id, 8)}..↔${truncate(args.node_b_id, 8)}..` : "";
    case "get_node":
    case "update_node":
    case "delete_node":
    case "list_links":
    case "mark_processed":
      return args.node_id ?? args.id ?? "";
    case "delete_link":
      return args.link_id ?? "";
    default:
      return "";
  }
}

const DESTRUCTIVE = new Set(["delete_node", "delete_link"]);

function prettyArgs(args: unknown): string {
  const decoded = decodeArgs(args);
  return decoded ? JSON.stringify(decoded, null, 2) : String(args);
}

function ToolCard({ call, expanded, onToggle }: { call: ToolCall; expanded: boolean; onToggle: () => void }) {
  return (
    <Collapsible open={expanded} onOpenChange={onToggle} className="rounded-lg border">
      <CollapsibleTrigger
        render={<Button variant="ghost" className="h-auto w-full justify-between px-3 py-2 font-normal" />}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Badge variant={call.success === false || DESTRUCTIVE.has(call.action) ? "destructive" : "secondary"}>{call.action ?? "unknown"}</Badge>
          <span className="truncate text-xs text-muted-foreground">{summary(call)}</span>
        </span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {call.durationMs !== null && <span className="tabular-nums">{formatDuration(call.durationMs)}</span>}
          <ChevronDownIcon className={cn("transition-transform", expanded && "rotate-180")} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 border-t px-3 py-2 font-mono text-xs">
        {call.args !== undefined && call.args !== null && (
          <div>
            <span className="text-muted-foreground">Args</span>
            <pre className="mt-1 whitespace-pre-wrap break-all leading-relaxed">{prettyArgs(call.args)}</pre>
          </div>
        )}
        {call.result && (
          <div>
            <span className="text-muted-foreground">Result</span>
            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">{call.result}</pre>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Conversation({ run, events }: { run: RunView; events: ActivityView[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const turns = groupIntoTurns(events);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const stat = (key: string) => String(run.stats[key] ?? 0);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-4 lg:p-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Retrospector</Badge>
          <KindBadge kind={run.kind} />
          <OutcomeBadge outcome={run.outcome} durationMs={run.durationMs} />
          <span className="text-sm text-muted-foreground">{formatRunDateTime(run.startedAt)}</span>
        </div>
        <p className="text-sm text-muted-foreground">{run.intent}</p>
      </div>
      {turns.map((turn) => (
        <Card key={turn.iteration} size="sm">
          <CardHeader>
            <CardTitle>{turn.final ? "Final" : `Iteration ${turn.iteration}`}</CardTitle>
            {turn.toolCalls.length > 0 && (
              <CardDescription>
                {turn.toolCalls.length} tool call{turn.toolCalls.length !== 1 ? "s" : ""}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {turn.narrative && (
              <p className="whitespace-pre-wrap text-sm italic leading-relaxed text-muted-foreground">{String(turn.narrative.meta.text ?? "")}</p>
            )}
            {turn.toolCalls.map((call) => (
              <ToolCard key={call.actionId} call={call} expanded={expanded.has(call.actionId)} onToggle={() => toggle(call.actionId)} />
            ))}
          </CardContent>
        </Card>
      ))}
      {run.outcome === "success" && Object.keys(run.stats).length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-3 text-sm">
            {[
              ["Processed", "nodes_processed"],
              ["Updated", "nodes_updated"],
              ["Links created", "links_created"],
              ["Insights", "insights_created"],
              ["Nodes deleted", "nodes_deleted"],
              ["Links deleted", "links_deleted"],
            ].map(([label, key]) => (
              <div key={key} className="flex flex-col">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium tabular-nums">{stat(key)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {run.outcome === "failure" && (
        <Alert variant="destructive">
          <AlertTitle>Run failed</AlertTitle>
        </Alert>
      )}
      {run.outcome === "interrupted" && (
        <Alert variant="destructive">
          <AlertTitle>Run interrupted</AlertTitle>
          <AlertDescription>No completion event arrived.</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
