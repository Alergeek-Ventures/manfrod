"use client";

import { useState, useTransition } from "react";
import { CalendarIcon, PlusIcon, SlidersHorizontalIcon } from "lucide-react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import type { CalendarStatus } from "@/lib/google.ts";
import type { ChannelAudience } from "@/lib/memory/access.ts";
import {
  addCustomProvider,
  disconnectProvider,
  kalafiorniaDisconnect,
  kalafiorniaSendPin,
  kalafiorniaVerifyPin,
  removeCustomProvider,
  updateCustomProviderAvailability,
  type ActionResult,
} from "./actions.ts";

interface ProviderView {
  id: string;
  name: string;
  mock: boolean;
  logoUrl: string | null;
  custom: boolean;
  availability: ChannelAudience[];
}

const AUDIENCES: { value: ChannelAudience; label: string; short: string; description: string }[] = [
  { value: "dm", label: "Direct messages", short: "DMs", description: "Your DMs with Manfrod." },
  {
    value: "internal",
    label: "Internal channels",
    short: "Internal",
    description: "The team's own channels, including internal project channels.",
  },
  {
    value: "external",
    label: "Client channels",
    short: "Client",
    description: "Channels shared with a client. The client sees whatever Manfrod posts there.",
  },
];

const DEFAULT_AVAILABILITY: ChannelAudience[] = ["dm", "internal"];

const availabilitySummary = (availability: ChannelAudience[]) =>
  AUDIENCES.filter((audience) => availability.includes(audience.value))
    .map((audience) => audience.short)
    .join(" · ");

type Run = (action: () => Promise<ActionResult>, onSuccess?: () => void) => void;

function ProviderLogo({ provider }: { provider: ProviderView }) {
  const src = provider.id === "firmowid" ? "/images/mcp/firmowid.png" : provider.logoUrl;
  return (
    <Avatar className="size-10 rounded-lg">
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback className="rounded-lg">{(provider.name || "?").charAt(0).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

function StatusBadge({ status, mock }: { status: string | undefined; mock: boolean }) {
  if (mock) return <Badge variant="outline">Coming soon</Badge>;
  if (status === "connected") return <Badge>Connected</Badge>;
  if (status === "expired") return <Badge variant="destructive">Expired</Badge>;
  return <Badge variant="outline">Not connected</Badge>;
}

function AvailabilityField({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: ChannelAudience[];
  onChange: (value: ChannelAudience[]) => void;
}) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Available in</FieldLegend>
      <FieldDescription>
        Manfrod uses this server only where you write to it. Everyone in the conversation sees replies built from its data.
      </FieldDescription>
      <FieldGroup data-slot="checkbox-group">
        {AUDIENCES.map((audience) => (
          <Field key={audience.value} orientation="horizontal">
            <Checkbox
              id={`${idPrefix}-${audience.value}`}
              checked={value.includes(audience.value)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...value, audience.value] : value.filter((current) => current !== audience.value))
              }
            />
            <FieldContent>
              <FieldLabel htmlFor={`${idPrefix}-${audience.value}`}>{audience.label}</FieldLabel>
              <FieldDescription>{audience.description}</FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </FieldGroup>
    </FieldSet>
  );
}

function AvailabilityDialog({ provider, run, pending }: { provider: ProviderView; run: Run; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState(provider.availability);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setAvailability(provider.availability);
        setOpen(next);
      }}
    >
      <DialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Availability" title="Availability" />}>
        <SlidersHorizontalIcon />
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => updateCustomProviderAvailability(provider.id, availability),
              () => setOpen(false),
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>{provider.name} availability</DialogTitle>
            <DialogDescription>Choose where Manfrod can use this server for you.</DialogDescription>
          </DialogHeader>
          <AvailabilityField idPrefix={`mcp-${provider.id}`} value={availability} onChange={setAvailability} />
          <DialogFooter>
            <Button type="submit" disabled={pending || availability.length === 0}>
              {pending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProviderCard({
  provider,
  status,
  deletable,
  run,
  pending,
}: {
  provider: ProviderView;
  status: string | undefined;
  deletable: boolean;
  run: Run;
  pending: boolean;
}) {
  const active = status === "connected" || status === "expired";
  return (
    <Card>
      <CardHeader className="flex items-center gap-3">
        <ProviderLogo provider={provider} />
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="truncate">{provider.name}</CardTitle>
          <CardDescription className="truncate">
            {provider.custom ? availabilitySummary(provider.availability) || "Not available anywhere" : "MCP server"}
          </CardDescription>
        </div>
        <CardAction className="ml-auto shrink-0">
          <StatusBadge status={status} mock={provider.mock} />
        </CardAction>
      </CardHeader>
      {!provider.mock && (
        <CardFooter className="mt-auto gap-2">
          <Button
            size="sm"
            variant={active ? "outline" : "default"}
            nativeButton={false}
            render={<a href={`/mcp/${provider.id}/connect`} />}
          >
            {active ? "Reconnect" : "Connect"}
          </Button>
          {active && (
            <ConfirmAction
              label="Disconnect"
              title={`Disconnect ${provider.name}?`}
              description="Manfrod will lose access to this account until you connect it again."
              confirmLabel="Disconnect"
              onConfirm={() => run(() => disconnectProvider(provider.id))}
            />
          )}
          {deletable && (
            <div className="ml-auto flex gap-1">
              <AvailabilityDialog provider={provider} run={run} pending={pending} />
              <ConfirmAction
                label="Remove"
                title={`Remove ${provider.name}?`}
                description="The server is removed for everyone who added it."
                confirmLabel="Remove"
                onConfirm={() => run(() => removeCustomProvider(provider.id))}
              />
            </div>
          )}
        </CardFooter>
      )}
    </Card>
  );
}

function AddProviderDialog({ run, pending }: { run: Run; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("");
  const [availability, setAvailability] = useState(DEFAULT_AVAILABILITY);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="h-full min-h-24 border-dashed" />}>
        <PlusIcon data-icon="inline-start" />
        Add MCP server
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              () => addCustomProvider(url, name, scope, availability),
              () => {
                setOpen(false);
                setUrl("");
                setName("");
                setScope("");
                setAvailability(DEFAULT_AVAILABILITY);
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Add custom MCP server</DialogTitle>
            <DialogDescription>
              Manfrod tries to detect the server&apos;s name and logo — if it can&apos;t, name it yourself.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="mcp-url">MCP URL</FieldLabel>
              <Input
                id="mcp-url"
                placeholder="https://mcp.example.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
              <Input id="mcp-name" placeholder="e.g. Acme MCP" value={name} onChange={(event) => setName(event.target.value)} />
              <FieldDescription>Optional — auto-detected if left blank.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="mcp-scope">OAuth scope</FieldLabel>
              <Input id="mcp-scope" placeholder="e.g. mcp read write" value={scope} onChange={(event) => setScope(event.target.value)} />
              <FieldDescription>Optional — only if the server requires specific scopes.</FieldDescription>
            </Field>
            <AvailabilityField idPrefix="mcp-new" value={availability} onChange={setAvailability} />
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={pending || url === "" || availability.length === 0}>
              {pending && <Spinner data-icon="inline-start" />}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KalafiorniaCard({
  connection,
  defaultEmail,
  run,
  pending,
}: {
  connection: { email: string } | null;
  defaultEmail: string;
  run: Run;
  pending: boolean;
}) {
  const [step, setStep] = useState<"status" | "email" | "pin">("status");
  const [email, setEmail] = useState(defaultEmail);
  const [pin, setPin] = useState("");
  return (
    <Card>
      <CardHeader className="flex items-center gap-3">
        <Avatar className="size-10 rounded-lg">
          <AvatarImage src="/images/mcp/kalafiornia.svg" alt="" className="object-contain p-1.5" />
          <AvatarFallback className="rounded-lg">K</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>Kalafiornia App</CardTitle>
          <CardDescription className="truncate" title={connection?.email}>
            {connection ? `Connected as ${connection.email}` : "Office door access"}
          </CardDescription>
        </div>
        <CardAction className="ml-auto shrink-0">
          {connection ? <Badge>Connected</Badge> : <Badge variant="outline">Not connected</Badge>}
        </CardAction>
      </CardHeader>
      <CardFooter className="mt-auto flex-col items-stretch gap-4">
        {step === "status" && (
          <div className="flex gap-2">
            <Button size="sm" variant={connection ? "outline" : "default"} onClick={() => setStep("email")}>
              {connection ? "Reconnect" : "Connect"}
            </Button>
            {connection && (
              <ConfirmAction
                label="Disconnect"
                title="Disconnect Kalafiornia?"
                confirmLabel="Disconnect"
                onConfirm={() => run(kalafiorniaDisconnect)}
              />
            )}
          </div>
        )}
        {step !== "status" && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (step === "email") {
                run(
                  () => kalafiorniaSendPin(email),
                  () => {
                    setStep("pin");
                    setPin("");
                  },
                );
              } else {
                run(
                  () => kalafiorniaVerifyPin(email, pin),
                  () => {
                    setStep("status");
                    setPin("");
                  },
                );
              }
            }}
          >
            <FieldGroup>
              {step === "email" ? (
                <Field>
                  <FieldLabel htmlFor="kalafiornia-email">Email</FieldLabel>
                  <Input id="kalafiornia-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor="kalafiornia-pin">PIN</FieldLabel>
                  <Input
                    id="kalafiornia-pin"
                    inputMode="numeric"
                    placeholder="1234"
                    value={pin}
                    onChange={(event) => setPin(event.target.value)}
                    required
                  />
                  <FieldDescription>Sent to {email}</FieldDescription>
                </Field>
              )}
            </FieldGroup>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                {step === "email" ? "Send PIN" : "Verify"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setStep("status")}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardFooter>
    </Card>
  );
}

const CALENDAR_STATES: Record<CalendarStatus, { badge: React.ReactNode; description: (email: string | null) => string }> = {
  connected: { badge: <Badge>Connected</Badge>, description: (email) => `Connected as ${email ?? "your Google account"}` },
  expired: {
    badge: <Badge variant="destructive">Expired</Badge>,
    description: () => "Access expired, reconnect to keep it working",
  },
  missing_scope: {
    badge: <Badge variant="destructive">No calendar access</Badge>,
    description: () => "Calendar access wasn't granted",
  },
  not_connected: { badge: <Badge variant="outline">Not connected</Badge>, description: () => "Lets Manfrod read your calendar" },
};

function GoogleCalendarCard({ status, email }: { status: CalendarStatus; email: string | null }) {
  const [pending, setPending] = useState(false);
  const state = CALENDAR_STATES[status];
  return (
    <Card>
      <CardHeader className="flex items-center gap-3">
        <Avatar className="size-10 rounded-lg">
          <AvatarImage src="/images/integrations/google-calendar.png" alt="" className="object-contain p-1.5" />
          <AvatarFallback className="rounded-lg">
            <CalendarIcon />
          </AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>Google Calendar</CardTitle>
          <CardDescription className="truncate" title={state.description(email)}>
            {state.description(email)}
          </CardDescription>
        </div>
        <CardAction className="ml-auto shrink-0">{state.badge}</CardAction>
      </CardHeader>
      <CardFooter className="mt-auto">
        <Button
          size="sm"
          variant={status === "connected" ? "outline" : "default"}
          disabled={pending}
          onClick={async () => {
            setPending(true);
            await authClient.signIn.social({ provider: "google", callbackURL: "/integrations", errorCallbackURL: "/integrations" });
          }}
        >
          {pending && <Spinner data-icon="inline-start" />}
          {status === "not_connected" ? "Connect" : "Reconnect"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function SectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-sm font-medium">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}

export function IntegrationsClient({
  builtin,
  custom,
  connections,
  kalafiornia,
  calendar,
  defaultEmail,
}: {
  builtin: ProviderView[];
  custom: ProviderView[];
  connections: Record<string, string>;
  kalafiornia: { email: string } | null;
  calendar: { status: CalendarStatus; email: string | null };
  defaultEmail: string;
}) {
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
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <SectionTitle title="MCP · Built-in" />
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @4xl/main:grid-cols-3">
          {builtin.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              status={connections[provider.id]}
              deletable={false}
              run={run}
              pending={pending}
            />
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <SectionTitle title="MCP · Custom" description="Add any MCP server by URL." />
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @4xl/main:grid-cols-3">
          {custom.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} status={connections[provider.id]} deletable run={run} pending={pending} />
          ))}
          <AddProviderDialog run={run} pending={pending} />
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <SectionTitle title="Other integrations" />
        <div className="grid grid-cols-1 gap-4 @xl/main:grid-cols-2 @4xl/main:grid-cols-3">
          <GoogleCalendarCard status={calendar.status} email={calendar.email} />
          <KalafiorniaCard connection={kalafiornia} defaultEmail={defaultEmail} run={run} pending={pending} />
        </div>
      </section>
    </div>
  );
}
