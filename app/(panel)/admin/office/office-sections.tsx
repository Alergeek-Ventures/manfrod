"use client";

import { useState, useTransition } from "react";
import { XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { addMember, removeMember, saveOfficeSettings, type Result } from "./actions.ts";
import type { EditorPerson } from "./types.ts";

export function useRun() {
  const [pending, startTransition] = useTransition();
  const run = (action: () => Promise<Result>, options: { quiet?: boolean; onSuccess?: (result: Result) => void } = {}) =>
    startTransition(async () => {
      const result = await action();
      if (!result.ok) toast.error(result.message);
      else {
        if (!options.quiet) toast.success(result.message);
        options.onSuccess?.(result);
      }
    });
  return { pending, run };
}

export function OfficeMembers({ members, people }: { members: EditorPerson[]; people: EditorPerson[] }) {
  const { pending, run } = useRun();
  const memberIds = new Set(members.map((member) => member.id));
  const candidates = people.filter((person) => !memberIds.has(person.id)).map((person) => ({ label: person.name, value: person.id }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Office members</CardTitle>
        <CardDescription>People who work from this office. Only they are counted when Manfrod plans who sits where.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Select items={candidates} value={null} onValueChange={(value) => value && run(() => addMember(value as string))}>
          <SelectTrigger className="w-full" disabled={pending || candidates.length === 0}>
            <SelectValue placeholder={candidates.length === 0 ? "Everyone is a member" : "Add a person"} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {candidates.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {members.map((member) => (
              <li key={member.id} className="flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pr-0.5 pl-3 text-sm">
                {member.name}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${member.name}`}
                  disabled={pending}
                  onClick={() => run(() => removeMember(member.id))}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

type Settings = { width: number; height: number; planChannelId: string | null; crowdedThreshold: number };

export function OfficeSettings({ settings }: { settings: Settings }) {
  const { pending, run } = useRun();
  const [form, setForm] = useState({
    width: String(settings.width),
    height: String(settings.height),
    planChannelId: settings.planChannelId ?? "",
  });
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>Map size in grid cells and where the daily desk plan goes.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(() =>
              saveOfficeSettings({
                width: Number(form.width),
                height: Number(form.height),
                planChannelId: form.planChannelId.trim() === "" ? null : form.planChannelId.trim(),
                crowdedThreshold: settings.crowdedThreshold,
              }),
            );
          }}
        >
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="office-width">Width</FieldLabel>
                <Input id="office-width" type="number" min={10} max={400} value={form.width} onChange={set("width")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="office-height">Height</FieldLabel>
                <Input id="office-height" type="number" min={10} max={400} value={form.height} onChange={set("height")} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="office-channel">Desk plan channel</FieldLabel>
              <Input id="office-channel" placeholder="C087QF130R3" value={form.planChannelId} onChange={set("planChannelId")} />
              <FieldDescription>Slack channel ID, e.g. of #biuro. Leave empty to not post plans.</FieldDescription>
            </Field>
          </FieldGroup>
          <div>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Save settings
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function OfficePreview({ src, date }: { src: string; date: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Today&apos;s map</CardTitle>
        <CardDescription>What Manfrod posts on Slack for {date}, with today&apos;s bookings.</CardDescription>
      </CardHeader>
      <CardContent>
        <img src={src} alt={`Desk map for ${date}`} className="w-full rounded-lg border" />
      </CardContent>
    </Card>
  );
}
