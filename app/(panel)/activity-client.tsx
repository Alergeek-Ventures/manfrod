"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState } from "react";
import { FilterXIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDetail, formatExpanded, formatTime, formatType, typeVariant, type ActivityView } from "@/components/activity-format.ts";

interface Filter {
  from: string | null;
  to: string | null;
  source: string | null;
  userId: string | null;
}

const ALL = "__all__";

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });

function describe(filter: Filter): string {
  const parts: string[] = [];
  if (filter.source) parts.push(`${filter.source.charAt(0).toUpperCase()}${filter.source.slice(1)} run`);
  if (filter.from) parts.push(`from ${formatDateTime(filter.from)}`);
  if (filter.to) parts.push(`to ${formatDateTime(filter.to)}`);
  if (filter.userId) parts.push(`user: ${filter.userId}`);
  return parts.join(" ");
}

function buildQuery(filter: Filter | null, overrides: Partial<Record<string, string | null>>): string {
  const params = new URLSearchParams();
  if (filter?.from) params.set("from", filter.from);
  if (filter?.to) params.set("to", filter.to);
  if (filter?.source) params.set("source", filter.source);
  if (filter?.userId) params.set("user_id", filter.userId);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query === "" ? "/" : `/?${query}`;
}

export function ActivityClient({
  initialEvents,
  users,
  filter,
  showAllLogs,
  maxEvents,
}: {
  initialEvents: ActivityView[];
  users: { id: string; label: string }[];
  filter: Filter | null;
  showAllLogs: boolean;
  maxEvents: number;
}) {
  const router = useRouter();
  const [events, setEvents] = useState(initialEvents);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const userItems = [{ label: "All people", value: ALL }, ...users.map((user) => ({ label: user.label, value: user.id }))];

  useEffect(() => setEvents(initialEvents), [initialEvents]);

  useEffect(() => {
    if (filter) return;
    const source = new EventSource("/api/activity/stream");
    source.onmessage = (message) => {
      const activity = JSON.parse(message.data) as ActivityView;
      if (activity.type === "response_chunk") return;
      if (activity.type === "log" && !showAllLogs && !["warning", "error"].includes(activity.meta.level)) return;
      setEvents((current) => [activity, ...current.filter((event) => event.id !== activity.id)].slice(0, maxEvents));
    };
    return () => source.close();
  }, [filter, showAllLogs, maxEvents]);

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      {filter && (
        <Alert>
          <AlertDescription>{describe(filter)}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => router.push("/")}>
              <FilterXIcon data-icon="inline-start" />
              Clear filter
            </Button>
          </AlertAction>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Live activity</CardTitle>
          <CardDescription>{filter ? `${events.length} events` : `${events.length} events · streaming`}</CardDescription>
          <CardAction className="flex items-center gap-4">
            {users.length > 0 && (
              <Select
                items={userItems}
                value={filter?.userId ?? ALL}
                onValueChange={(value) => router.push(buildQuery(filter, { user_id: value === ALL ? null : (value as string) }))}
              >
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {userItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
            <Field orientation="horizontal">
              <Switch
                id="all-logs"
                checked={showAllLogs}
                onCheckedChange={() => router.push(buildQuery(filter, { all_logs: showAllLogs ? null : "1" }))}
              />
              <FieldLabel htmlFor="all-logs">All logs</FieldLabel>
            </Field>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Table className="font-mono text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Time</TableHead>
                <TableHead className="w-44">Type</TableHead>
                <TableHead className="w-32">Source</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <Fragment key={event.id}>
                  <TableRow className="cursor-pointer" onClick={() => toggle(event.id)}>
                    <TableCell className="tabular-nums text-muted-foreground">{formatTime(event.timestamp)}</TableCell>
                    <TableCell>
                      <Badge variant={typeVariant(event)}>{formatType(event)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{event.source || "–"}</TableCell>
                    <TableCell className="max-w-0 truncate">{formatDetail(event)}</TableCell>
                  </TableRow>
                  {expanded.has(event.id) && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="bg-muted/40">
                        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed text-muted-foreground">
                          {formatExpanded(event)}
                        </pre>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
