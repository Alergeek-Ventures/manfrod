import { Alert, AlertDescription } from "@/components/ui/alert";
import { getGoogleAccount } from "@/lib/accounts.ts";
import { calendarStatus } from "@/lib/google.ts";
import { getConnection as getKalafiornia } from "@/lib/kalafiornia.ts";
import { listConnections, providersForUser } from "@/lib/mcp/index.ts";
import { requireUser } from "@/lib/web/session.ts";
import { IntegrationsClient } from "./integrations-client.tsx";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; info?: string }> }) {
  const user = await requireUser();
  const { error, info } = await searchParams;
  const providers = await providersForUser(user.id);
  const connections = Object.fromEntries(
    [...(await listConnections(user.id)).entries()].map(([provider, connection]) => [provider, connection.status]),
  );
  const kalafiornia = await getKalafiornia(user.id);
  const calendar = await calendarStatus(await getGoogleAccount(user.id));

  return (
    <div className="flex flex-col gap-6 p-4 lg:p-6">
      <p className="max-w-3xl text-sm text-muted-foreground">
        Connect your own accounts so Manfrod can use them when it talks to you — in DMs or in a thread started with you in a channel.
        Connections are per-person: connecting one here only gives the agent access to yours, not anyone else&apos;s.
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {info && (
        <Alert>
          <AlertDescription>{info}</AlertDescription>
        </Alert>
      )}
      <IntegrationsClient
        builtin={providers.filter((provider) => !provider.custom)}
        custom={providers.filter((provider) => provider.custom)}
        connections={connections}
        kalafiornia={kalafiornia ? { email: kalafiornia.email } : null}
        calendar={{ status: calendar, email: user.email }}
        defaultEmail={kalafiornia?.email ?? user.email ?? ""}
      />
    </div>
  );
}
