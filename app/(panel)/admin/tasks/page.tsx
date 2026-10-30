import { ExternalLink } from "@/components/external-link";
import { SectionCards } from "@/components/section-cards";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLocal } from "@/lib/time.ts";
import { loadTasks, type TasksData } from "@/lib/web/agent-work.ts";
import { requireAdmin } from "@/lib/web/session.ts";
import { CancelTask } from "./cancel-task.tsx";

export const dynamic = "force-dynamic";

type Task = TasksData["tasks"][number];

const STATUS_VARIANTS: Record<string, React.ComponentProps<typeof Badge>["variant"]> = {
  active: "default",
  blocked: "secondary",
  done: "outline",
  cancelled: "secondary",
  failed: "destructive",
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
  merged: "outline",
  closed: "secondary",
};

const stamp = (date: Date | null) => (date ? formatLocal(date) : "–");

function interval(minutes: number): string {
  if (minutes % 1440 === 0) return `every ${minutes / 1440} d`;
  if (minutes % 60 === 0) return `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

function Status({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANTS[status] ?? "secondary"}>{status}</Badge>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm tabular-nums">{children}</span>
    </div>
  );
}

function NoData({ children }: { children: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Nothing here</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function OpenTask({ task }: { task: Task }) {
  const latest = task.updates.at(-1);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {task.title}
          <Status status={task.status} />
        </CardTitle>
        <CardDescription>
          {task.ownerName ?? task.ownerSlackId ?? "?"} · started {stamp(task.insertedAt)}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <ExternalLink href={task.link}>Thread</ExternalLink>
          <CancelTask id={task.id} title={task.title} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4 @3xl/main:grid-cols-5">
          <Fact label="Schedule">{interval(task.checkEveryMinutes)}, workdays 8–18</Fact>
          <Fact label="Next check">{stamp(task.nextCheckAt)}</Fact>
          <Fact label="Checks">
            {task.checks} / {task.maxChecks}
          </Fact>
          <Fact label="Deadline">{stamp(task.deadline)}</Fact>
          <Fact label="DMs sent">{task.dms.length}</Fact>
        </div>
        <div className="grid gap-4 @3xl/main:grid-cols-2">
          <Fact label="Goal">
            <span className="whitespace-pre-wrap">{task.goal}</span>
          </Fact>
          <Fact label="Done when">
            <span className="whitespace-pre-wrap">{task.successCriteria}</span>
          </Fact>
        </div>
        <Fact label="Latest progress">{latest ? `${stamp(latest.insertedAt)} · ${latest.content}` : "No progress notes yet"}</Fact>
        {(task.updates.length > 1 || task.plan || task.dms.length > 0) && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Plan, history and messages</summary>
            <div className="mt-3 flex flex-col gap-4">
              {task.plan && (
                <Fact label="Plan">
                  <span className="whitespace-pre-wrap">{task.plan}</span>
                </Fact>
              )}
              {task.updates.length > 0 && (
                <Fact label="History">
                  <ul className="flex flex-col gap-1">
                    {task.updates.map((update) => (
                      <li key={update.id}>
                        <span className="text-muted-foreground">{stamp(update.insertedAt)}</span> {update.content}
                      </li>
                    ))}
                  </ul>
                </Fact>
              )}
              {task.dms.length > 0 && (
                <Fact label="Direct messages">
                  <ul className="flex flex-col gap-1">
                    {task.dms.map((dm) => (
                      <li key={dm.id}>
                        <span className="text-muted-foreground">{stamp(dm.at)}</span> to {dm.recipient ?? "?"}:{" "}
                        <span className="text-muted-foreground">{dm.text.length > 160 ? `${dm.text.slice(0, 160)}…` : dm.text}</span>{" "}
                        <ExternalLink href={dm.link}>open</ExternalLink>
                      </li>
                    ))}
                  </ul>
                </Fact>
              )}
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

export default async function TasksPage() {
  await requireAdmin();
  const { tasks, requests, closedWindowDays } = await loadTasks();
  const open = tasks.filter((task) => task.status === "active" || task.status === "blocked");
  const closed = tasks.filter((task) => task.status !== "active" && task.status !== "blocked");
  const count = (status: string) => tasks.filter((task) => task.status === status).length;

  return (
    <div className="flex flex-col gap-6 py-4 md:py-6">
      <SectionCards
        metrics={[
          { label: "Active", value: count("active"), sublabel: "checked on schedule" },
          { label: "Blocked", value: count("blocked"), sublabel: "waiting for a capability" },
          { label: "Done", value: count("done"), sublabel: `last ${closedWindowDays} days` },
          { label: "Failed or cancelled", value: count("failed") + count("cancelled"), sublabel: `last ${closedWindowDays} days` },
          {
            label: "Capability requests",
            value: requests.filter((request) => request.status === "pending").length,
            sublabel: "waiting for an admin",
          },
        ]}
      />

      <section className="flex flex-col gap-4 px-4 lg:px-6">
        <h2 className="text-sm font-medium text-muted-foreground">Open tasks</h2>
        {open.length === 0 ? (
          <NoData>Manfrod starts a task with create-task when something needs following up over days.</NoData>
        ) : (
          open.map((task) => <OpenTask key={task.id} task={task} />)
        )}
      </section>

      <section className="flex flex-col gap-4 px-4 lg:px-6">
        <h2 className="text-sm font-medium text-muted-foreground">Closed in the last {closedWindowDays} days</h2>
        <Card>
          <CardContent>
            {closed.length === 0 ? (
              <NoData>No tasks closed recently.</NoData>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="text-right">Checks</TableHead>
                    <TableHead>Closed</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {closed.map((task) => (
                    <TableRow key={task.id} className="align-top">
                      <TableCell className="font-medium whitespace-normal">{task.title}</TableCell>
                      <TableCell>{task.ownerName ?? "–"}</TableCell>
                      <TableCell>
                        <Status status={task.status} />
                      </TableCell>
                      <TableCell className="max-w-md whitespace-normal text-muted-foreground">{task.outcome ?? "–"}</TableCell>
                      <TableCell className="text-right tabular-nums">{task.checks}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{stamp(task.closedAt)}</TableCell>
                      <TableCell>
                        <ExternalLink href={task.link}>Thread</ExternalLink>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4 px-4 lg:px-6">
        <h2 className="text-sm font-medium text-muted-foreground">Capability requests</h2>
        <Card>
          <CardContent>
            {requests.length === 0 ? (
              <NoData>Manfrod asks for a new capability with request-capability when a task needs something it can&apos;t do.</NoData>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Capability</TableHead>
                    <TableHead>Requested by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Pull request</TableHead>
                    <TableHead>Requested</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((request) => (
                    <TableRow key={request.id} className="align-top">
                      <TableCell className="max-w-md whitespace-normal">
                        <div className="font-medium">{request.title}</div>
                        <div className="text-muted-foreground">{request.reason}</div>
                      </TableCell>
                      <TableCell>{request.requester ?? "–"}</TableCell>
                      <TableCell>
                        <Status status={request.status} />
                      </TableCell>
                      <TableCell>
                        <ExternalLink href={request.pullUrl}>{request.pullNumber ? `#${request.pullNumber}` : "PR"}</ExternalLink>
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{stamp(request.insertedAt)}</TableCell>
                      <TableCell>
                        <ExternalLink href={request.link}>Thread</ExternalLink>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
