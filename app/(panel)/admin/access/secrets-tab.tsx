"use client";

import { useState } from "react";
import { CopyIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccessData } from "@/lib/web/access-data.ts";
import type { Run } from "./access-client.tsx";
import { saveSecret, saveSecretDescription, removeSecret } from "./actions.ts";

const placeholder = (name: string) => `{{ ${name} }}`;

function SecretDialog({ run, pending, existing }: { run: Run; pending: boolean; existing?: { name: string; description: string | null } }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ name: existing?.name ?? "", value: "", description: existing?.description ?? "" });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft({ name: existing?.name ?? "", value: "", description: existing?.description ?? "" });
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
            const action =
              existing && draft.value === ""
                ? () => saveSecretDescription(existing.name, draft.description)
                : () => saveSecret(draft.name, draft.value, draft.description);
            run(action, () => setOpen(false));
          }}
        >
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.name}` : "Add secret"}</DialogTitle>
            <DialogDescription>Values are encrypted and never shown again.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="secret-name">Name</FieldLabel>
              <Input
                id="secret-name"
                className="font-mono uppercase"
                placeholder="SECRET_NAME"
                disabled={Boolean(existing)}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
                required
              />
              <FieldDescription>Use it in skills as {placeholder(draft.name || "NAME")}.</FieldDescription>
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
            <Button type="submit" disabled={pending || draft.name === "" || (!existing && draft.value === "")}>
              {pending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function SecretsTab({ secrets, run, pending }: { secrets: AccessData["secrets"]; run: Run; pending: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
        <CardDescription>
          Reference a secret in a skill or instruction as {placeholder("NAME")}. The agent only sees the placeholder; the value is filled in
          when a tool runs. Tools that save notes, souls or reminders keep the placeholder.
        </CardDescription>
        <CardAction>
          <SecretDialog run={run} pending={pending} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {secrets.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle>No secrets yet</EmptyTitle>
              <EmptyDescription>Add an API key or ID that skills should use without seeing it.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Placeholder</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.map((secret) => (
                <TableRow key={secret.name}>
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
                  <TableCell className="whitespace-normal text-muted-foreground">{secret.description || "–"}</TableCell>
                  <TableCell className="font-mono text-muted-foreground">••••••••</TableCell>
                  <TableCell className="text-muted-foreground">
                    {secret.updated_at?.slice(0, 16).replace("T", " ")}
                    {secret.updated_by ? ` · ${secret.updated_by}` : ""}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <SecretDialog run={run} pending={pending} existing={{ name: secret.name, description: secret.description }} />
                      <ConfirmAction
                        label="Delete"
                        title={`Delete ${secret.name}?`}
                        description="Skills that use this placeholder will fail until it is added again."
                        confirmLabel="Delete"
                        onConfirm={() => run(() => removeSecret(secret.name))}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
