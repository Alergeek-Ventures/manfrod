"use client";

import { useState, useTransition } from "react";
import { CopyIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deleteSecretAction, saveSecretAction, type Result } from "./actions.ts";

export interface SecretRow {
  id: string;
  name: string;
  description: string | null;
  scope: "company" | "personal";
  hosts: string[];
  owner: string | null;
  mine: boolean;
  updatedAt: string;
}

type Run = (action: () => Promise<Result>, onSuccess?: () => void) => void;

const placeholder = (name: string) => `{{ ${name} }}`;

function SecretDialog({ scope, run, pending, existing }: { scope: SecretRow["scope"]; run: Run; pending: boolean; existing?: SecretRow }) {
  const initial = () => ({
    name: existing?.name ?? "",
    value: "",
    description: existing?.description ?? "",
    hosts: existing?.hosts.join(", ") ?? "",
  });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(initial());
      }}
    >
      <DialogTrigger render={existing ? <Button variant="ghost" size="sm" /> : <Button size="sm" />}>
        {existing ? (
          "Edit"
        ) : (
          <>
            <PlusIcon data-icon="inline-start" />
            Add secret
          </>
        )}
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => saveSecretAction({ ...draft, scope }),
              () => setOpen(false),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {existing ? `Edit ${existing.name}` : scope === "company" ? "Add company secret" : "Add personal secret"}
            </DialogTitle>
            <DialogDescription>Values are encrypted and never shown again, not even to Manfrod.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="secret-name">Name</FieldLabel>
              <Input
                id="secret-name"
                className="font-mono uppercase"
                placeholder="GITHUB_TOKEN"
                disabled={Boolean(existing)}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
                required
              />
              <FieldDescription>Use it in skills and requests as {placeholder(draft.name || "NAME")}.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-hosts">Allowed hosts</FieldLabel>
              <Input
                id="secret-hosts"
                className="font-mono"
                placeholder="api.github.com, *.example.com"
                value={draft.hosts}
                onChange={(event) => setDraft({ ...draft, hosts: event.target.value })}
                required
              />
              <FieldDescription>Manfrod only sends the secret to these hosts.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-value">{existing ? "New value" : "Value"}</FieldLabel>
              <Input
                id="secret-value"
                type="password"
                autoComplete="off"
                className="font-mono"
                value={draft.value}
                onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                required={!existing}
              />
              {existing && <FieldDescription>Leave empty to keep the current value.</FieldDescription>}
            </Field>
            <Field>
              <FieldLabel htmlFor="secret-description">Description</FieldLabel>
              <Input
                id="secret-description"
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || draft.name === "" || draft.hosts.trim() === "" || (!existing && draft.value === "")}>
              {pending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SecretsTable({
  rows,
  run,
  pending,
  editable,
  showOwner,
}: {
  rows: SecretRow[];
  run: Run;
  pending: boolean;
  editable: boolean;
  showOwner?: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Placeholder</TableHead>
          {showOwner && <TableHead>Owner</TableHead>}
          <TableHead>Hosts</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((secret) => (
          <TableRow key={secret.id}>
            <TableCell>
              <Button
                variant="ghost"
                size="sm"
                className="font-mono"
                onClick={() => {
                  void navigator.clipboard?.writeText(placeholder(secret.name));
                  toast.success("Placeholder copied");
                }}
              >
                {placeholder(secret.name)}
                <CopyIcon data-icon="inline-end" />
              </Button>
            </TableCell>
            {showOwner && <TableCell>{secret.owner ?? "–"}</TableCell>}
            <TableCell className="font-mono text-muted-foreground">{secret.hosts.join(", ") || "no hosts, unusable"}</TableCell>
            <TableCell className="whitespace-normal text-muted-foreground">{secret.description || "–"}</TableCell>
            <TableCell className="text-muted-foreground">{secret.updatedAt.slice(0, 16).replace("T", " ")}</TableCell>
            <TableCell>
              <div className="flex justify-end gap-1">
                {editable && <SecretDialog scope={secret.scope} run={run} pending={pending} existing={secret} />}
                {(editable || showOwner) && (
                  <ConfirmAction
                    label="Delete"
                    title={`Delete ${secret.name}?`}
                    description="Requests and skills that use this placeholder will fail until it is added again."
                    confirmLabel="Delete"
                    onConfirm={() => run(() => deleteSecretAction(secret.id))}
                  />
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Section({
  title,
  description,
  action,
  empty,
  children,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  empty: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>
        {empty ? (
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

export function SecretsClient({ rows, admin }: { rows: SecretRow[]; admin: boolean }) {
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
  const mine = rows.filter((row) => row.scope === "personal" && row.mine);
  const company = rows.filter((row) => row.scope === "company");
  const others = rows.filter((row) => row.scope === "personal" && !row.mine);
  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <Section
        title="My secrets"
        description="API keys and tokens only you can use. Manfrod fills them in when it calls an API for you, only for the hosts you allow, and never sees the values. You can also add them from Slack when Manfrod asks."
        action={<SecretDialog scope="personal" run={run} pending={pending} />}
        empty={mine.length === 0 ? "Add a key for an API you want Manfrod to call for you." : null}
      >
        <SecretsTable rows={mine} run={run} pending={pending} editable />
      </Section>
      <Section
        title="Company secrets"
        description={admin ? "Everyone can use these. Only admins add and change them." : "Everyone can use these. Admins manage them."}
        action={admin ? <SecretDialog scope="company" run={run} pending={pending} /> : undefined}
        empty={company.length === 0 ? "No company secrets yet." : null}
      >
        <SecretsTable rows={company} run={run} pending={pending} editable={admin} />
      </Section>
      {admin && (
        <Section
          title="Other people's personal secrets"
          description="Only their owners can use these. As an admin you can see the names and delete them, not use them."
          empty={others.length === 0 ? "Nobody else has added a personal secret." : null}
        >
          <SecretsTable rows={others} run={run} pending={pending} editable={false} showOwner />
        </Section>
      )}
    </div>
  );
}
