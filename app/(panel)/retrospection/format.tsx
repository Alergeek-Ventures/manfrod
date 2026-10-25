import { CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

type Outcome = "success" | "failure" | "running" | "interrupted";
type Kind = "slipbox_drain" | "graph_review" | null;

export interface RunView {
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  outcome: Outcome;
  intent: string;
  stats: Record<string, unknown>;
  kind: Kind;
}

export const formatRunDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "...";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s`;
}

export function runStats(stats: Record<string, unknown>): [string, unknown][] {
  return (
    [
      ["processed", stats.nodes_processed],
      ["linked", stats.links_created],
      ["insights", stats.insights_created],
      ["deleted", stats.nodes_deleted],
    ] as [string, unknown][]
  ).filter(([, value]) => value !== undefined && value !== null && value !== 0);
}

export function KindBadge({ kind }: { kind: Kind }) {
  const text = kind === "slipbox_drain" ? "Slipbox drain" : kind === "graph_review" ? "Graph review" : "Unknown";
  return <Badge variant={kind === null ? "outline" : "secondary"}>{text}</Badge>;
}

export function OutcomeBadge({ outcome, durationMs }: { outcome: Outcome; durationMs: number | null }) {
  if (outcome === "success") {
    return (
      <Badge variant="outline">
        <CircleCheckIcon data-icon="inline-start" />
        {formatDuration(durationMs)}
      </Badge>
    );
  }
  if (outcome === "failure") {
    return (
      <Badge variant="destructive">
        <CircleXIcon data-icon="inline-start" />
        Failed
      </Badge>
    );
  }
  if (outcome === "running") {
    return (
      <Badge variant="secondary">
        <Spinner data-icon="inline-start" />
        Running
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <TriangleAlertIcon data-icon="inline-start" />
      Interrupted
    </Badge>
  );
}
