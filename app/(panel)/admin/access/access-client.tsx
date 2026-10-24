"use client";

import { useState, useTransition } from "react";
import { PencilIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { AccessData } from "@/lib/web/access-data.ts";
import {
  addProject,
  cancelReminder,
  deleteCron,
  deleteMapping,
  deleteVacation,
  revokeLinear,
  saveCron,
  saveVacation,
  setMappingStatus,
  toggleCron,
  updateVacation,
  type Result,
} from "./actions.ts";
import { SecretsTab } from "./secrets-tab.tsx";
import type { Tab } from "./tabs.ts";

export type Run = (action: () => Promise<Result>, onSuccess?: () => void) => void;

const formatStamp = (value: string | null | undefined) => (value ? value.slice(0, 16).replace("T", " ") : "–");

function Section({
  title,
  description,
  action,
  empty,
  isEmpty,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  empty: string;
  isEmpty: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Nothing here yet</EmptyTitle>
              <EmptyDescription>{empty}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function FormDialog({
  trigger,
  title,
  description,
  submitLabel,
  pending,
  onSubmit,
  children,
}: {
  trigger: React.ReactNode;
  title: string;
  description?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (close: () => void) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" />}>{trigger}</DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(() => setOpen(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <FieldGroup>{children}</FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChannelsTab({ data, run }: { data: AccessData; run: Run }) {
  return (
    <Section
      title="Channels"
      description="Slack channels mapped to projects and clients."
      empty="Send a message in a channel — auto-detection will add it."
      isEmpty={data.channels.length === 0}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Channel</TableHead>
            <TableHead>ID</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Client ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Source</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.channels.map((channel) => (
            <TableRow key={channel.id}>
              <TableCell className="font-medium">{channel.slack_channel_name ? `#${channel.slack_channel_name}` : "–"}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{channel.slack_channel_id}</TableCell>
              <TableCell>{channel.project_slug ?? "–"}</TableCell>
              <TableCell>{channel.client_id ?? "–"}</TableCell>
              <TableCell>
                <Badge variant={channel.status === "active" ? "default" : "secondary"}>{channel.status}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{channel.source}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => run(() => setMappingStatus(channel.id, channel.status === "active" ? "pending" : "active"))}
                  >
                    {channel.status === "active" ? "Deactivate" : "Activate"}
                  </Button>
                  <ConfirmAction label="Delete" title="Delete this mapping?" confirmLabel="Delete" onConfirm={() => run(() => deleteMapping(channel.id))} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function ProjectsTab({ data, run, pending }: { data: AccessData; run: Run; pending: boolean }) {
  const [project, setProject] = useState({ slug: "", name: "" });
  return (
    <Section
      title="Projects"
      empty="No projects yet."
      isEmpty={data.projects.length === 0}
      action={
        <FormDialog
          trigger={
            <>
              <PlusIcon data-icon="inline-start" />
              Add project
            </>
          }
          title="New project"
          submitLabel="Save"
          pending={pending}
          onSubmit={(close) =>
            run(
              () => addProject(project.slug, project.name),
              () => {
                close();
                setProject({ slug: "", name: "" });
              },
            )
          }
        >
          <Field>
            <FieldLabel htmlFor="project-slug">Slug</FieldLabel>
            <Input id="project-slug" placeholder="client-abc" value={project.slug} onChange={(event) => setProject({ ...project, slug: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="project-name">Name</FieldLabel>
            <Input id="project-name" placeholder="Client ABC Inc." value={project.name} onChange={(event) => setProject({ ...project, name: event.target.value })} />
          </Field>
        </FormDialog>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Slug</TableHead>
            <TableHead>Name</TableHead>
            <TableHead className="text-right">Channels</TableHead>
            <TableHead className="text-right">Members</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.projects.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-mono text-xs">{row.slug}</TableCell>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="text-right tabular-nums">{row.channel_count}</TableCell>
              <TableCell className="text-right tabular-nums">{row.member_count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function MembersTab({ data }: { data: AccessData }) {
  return (
    <Section title="Members" description="Project memberships by person." empty="No memberships yet." isEmpty={data.members.length === 0}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Slack ID</TableHead>
            <TableHead>Projects</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.members.map((member) => (
            <TableRow key={member.user_slack_id}>
              <TableCell className="font-medium">{member.user_name ?? "–"}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{member.user_slack_id}</TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {member.memberships.map((membership) => (
                    <Badge key={membership.project_slug} variant="secondary">
                      {membership.project_name}
                    </Badge>
                  ))}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function VacationsTab({ data, run, pending }: { data: AccessData; run: Run; pending: boolean }) {
  const [vacation, setVacation] = useState({ userId: "", startDate: "", endDate: "", note: "vacation" });
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const userItems = data.users.map((user) => ({ label: user.label, value: user.id }));
  return (
    <Section
      title="Vacations"
      description='Saved as facts with access ["internal", "external/all"].'
      empty="No vacations or absences saved."
      isEmpty={data.vacations.length === 0}
      action={
        <FormDialog
          trigger={
            <>
              <PlusIcon data-icon="inline-start" />
              Add vacation
            </>
          }
          title="Add vacation"
          submitLabel="Save"
          pending={pending}
          onSubmit={(close) =>
            run(
              () => saveVacation(vacation.userId, vacation.startDate, vacation.endDate, vacation.note),
              () => {
                close();
                setVacation({ userId: vacation.userId, startDate: "", endDate: "", note: "vacation" });
              },
            )
          }
        >
          <Field>
            <FieldLabel>Person</FieldLabel>
            <Select items={userItems} value={vacation.userId || null} onValueChange={(value) => setVacation({ ...vacation, userId: (value as string) ?? "" })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a person" />
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
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="vacation-from">From</FieldLabel>
              <Input id="vacation-from" type="date" value={vacation.startDate} onChange={(event) => setVacation({ ...vacation, startDate: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="vacation-to">To</FieldLabel>
              <Input id="vacation-to" type="date" value={vacation.endDate} onChange={(event) => setVacation({ ...vacation, endDate: event.target.value })} />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="vacation-note">Description</FieldLabel>
            <Input id="vacation-note" value={vacation.note} onChange={(event) => setVacation({ ...vacation, note: event.target.value })} />
          </Field>
        </FormDialog>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Access</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.vacations.map((row) => (
            <TableRow key={row.id} className="align-top">
              <TableCell>
                <div className="font-medium">{row.user_name ?? "–"}</div>
                <div className="font-mono text-xs text-muted-foreground">{row.user_slack_id ?? "system"}</div>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">{row.key}</TableCell>
              <TableCell className="min-w-80 whitespace-normal">
                {editing?.id === row.id ? (
                  <Textarea value={editing.value} onChange={(event) => setEditing({ id: row.id, value: event.target.value })} />
                ) : (
                  <span className="whitespace-pre-wrap">{row.value}</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {(row.access as string[]).map((level) => (
                    <Badge key={level} variant="outline">
                      {level}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{formatStamp(row.updated_at ?? row.inserted_at)}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  {editing?.id === row.id ? (
                    <>
                      <Button size="sm" onClick={() => run(() => updateVacation(row.id, editing.value), () => setEditing(null))}>
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ id: row.id, value: row.value })}>
                        <PencilIcon data-icon="inline-start" />
                        Edit
                      </Button>
                      <ConfirmAction label="Delete" title="Delete this vacation?" confirmLabel="Delete" onConfirm={() => run(() => deleteVacation(row.id))} />
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

type CronDraft = { id: string; cron: string; timezone: string; instructions: string };

function CronTab({ data, run }: { data: AccessData; run: Run }) {
  const [editing, setEditing] = useState<CronDraft | null>(null);
  return (
    <Section
      title="Cron skills & recurring reminders"
      description="Cron skills come from SKILL.md frontmatter and are read-only here; recurring reminders are added by people through the agent."
      empty="No scheduled tasks."
      isEmpty={data.cronRows.length === 0}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Cron</TableHead>
            <TableHead>Timezone</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.cronRows.map((row) => {
            const draft = row.type === "user" && editing?.id === row.id ? editing : null;
            return (
              <TableRow key={`${row.type}-${row.id ?? row.name}`} className="align-top">
                <TableCell className="font-mono text-xs">{row.name}</TableCell>
                <TableCell>
                  <Badge variant={row.type === "skill" ? "secondary" : "outline"}>{row.type === "skill" ? "Skill" : "User"}</Badge>
                </TableCell>
                <TableCell>
                  {draft ? (
                    <Input className="w-36 font-mono" value={draft.cron} onChange={(event) => setEditing({ ...draft, cron: event.target.value })} />
                  ) : (
                    <span className="font-mono text-xs">{row.cron}</span>
                  )}
                </TableCell>
                <TableCell>
                  {draft ? <Input className="w-36" value={draft.timezone} onChange={(event) => setEditing({ ...draft, timezone: event.target.value })} /> : row.timezone}
                </TableCell>
                <TableCell>
                  <div>{row.owner_name ?? "–"}</div>
                  {row.owner_slack_id && <div className="font-mono text-xs text-muted-foreground">{row.owner_slack_id}</div>}
                  {row.channel && <div className="font-mono text-xs text-muted-foreground">channel: {row.channel}</div>}
                </TableCell>
                <TableCell className="max-w-xs whitespace-normal text-muted-foreground">
                  {draft ? (
                    <Textarea value={draft.instructions} onChange={(event) => setEditing({ ...draft, instructions: event.target.value })} />
                  ) : (
                    <span className="whitespace-pre-wrap">{row.detail}</span>
                  )}
                </TableCell>
                <TableCell>
                  {row.type === "skill" ? (
                    <span className="text-muted-foreground">–</span>
                  ) : (
                    <Switch checked={row.enabled} onCheckedChange={() => run(() => toggleCron(row.id!))} />
                  )}
                </TableCell>
                <TableCell>
                  {row.type === "user" && (
                    <div className="flex justify-end gap-1">
                      {draft ? (
                        <>
                          <Button size="sm" onClick={() => run(() => saveCron(draft.id, draft.cron, draft.timezone, draft.instructions), () => setEditing(null))}>
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditing({ id: row.id!, cron: row.cron, timezone: row.timezone, instructions: row.detail })}
                          >
                            <PencilIcon data-icon="inline-start" />
                            Edit
                          </Button>
                          <ConfirmAction label="Delete" title="Delete this recurring reminder?" confirmLabel="Delete" onConfirm={() => run(() => deleteCron(row.id!))} />
                        </>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}

function RemindersTab({ data, run }: { data: AccessData; run: Run }) {
  return (
    <Section
      title="Reminders"
      description="One-time reminders set through the agent. Recurring ones live under Cron skills."
      empty="No pending reminders."
      isEmpty={data.reminderRows.length === 0}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Message</TableHead>
            <TableHead>Scheduled at</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.reminderRows.map((reminder) => (
            <TableRow key={reminder.id} className="align-top">
              <TableCell className="max-w-md whitespace-pre-wrap">{reminder.message}</TableCell>
              <TableCell className="tabular-nums text-muted-foreground">{formatStamp(reminder.scheduled_at)}</TableCell>
              <TableCell>
                <div>{reminder.owner_name ?? "–"}</div>
                {reminder.owner_slack_id && <div className="font-mono text-xs text-muted-foreground">{reminder.owner_slack_id}</div>}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{reminder.state}</Badge>
              </TableCell>
              <TableCell>
                <div className="flex justify-end">
                  <ConfirmAction label="Cancel" title="Cancel this reminder?" confirmLabel="Cancel reminder" onConfirm={() => run(() => cancelReminder(reminder.id))} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

function LinearTab({ data, run }: { data: AccessData; run: Run }) {
  return (
    <Section
      title="Linear"
      description="Per-project Linear connections. Connect one with /linear-status in a project channel."
      empty="No Linear connections yet."
      isEmpty={data.linearConnections.length === 0}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Team</TableHead>
            <TableHead>API key</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Connected</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.linearConnections.map((connection) => (
            <TableRow key={connection.id}>
              <TableCell className="font-medium">{connection.project_slug ?? "–"}</TableCell>
              <TableCell>{connection.linear_team_name ?? "–"}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">••••••••</TableCell>
              <TableCell>
                <Badge variant={connection.status === "connected" ? "default" : "secondary"}>{connection.status}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">{formatStamp(connection.inserted_at)}</TableCell>
              <TableCell>
                <div className="flex justify-end">
                  {connection.status === "connected" && (
                    <ConfirmAction label="Revoke" title="Revoke this Linear connection?" confirmLabel="Revoke" onConfirm={() => run(() => revokeLinear(connection.id))} />
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Section>
  );
}

export function AccessClient({ tab, data }: { tab: Tab; data: AccessData }) {
  const [pending, startTransition] = useTransition();

  const run: Run = (action, onSuccess) =>
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        toast.success(result.message);
        onSuccess?.();
      } else {
        toast.error(result.message);
      }
    });

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      {tab === "channels" && <ChannelsTab data={data} run={run} />}
      {tab === "projects" && <ProjectsTab data={data} run={run} pending={pending} />}
      {tab === "members" && <MembersTab data={data} />}
      {tab === "vacations" && <VacationsTab data={data} run={run} pending={pending} />}
      {tab === "cron" && <CronTab data={data} run={run} />}
      {tab === "reminders" && <RemindersTab data={data} run={run} />}
      {tab === "linear" && <LinearTab data={data} run={run} />}
      {tab === "secrets" && <SecretsTab secrets={data.secrets} run={run} pending={pending} />}
    </div>
  );
}
