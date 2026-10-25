import { asc, eq } from "drizzle-orm";
import { findOrCreateBySlackId, getUserBySlackId, isAdmin } from "../accounts.ts";
import { db, tables } from "../db/index.ts";
import { postStatus } from "../linear/status.ts";
import { getActiveMapping } from "../memory/access.ts";
import { fetchUserInfo, getChannelInfo, openDm, post } from "./api.ts";

const { channelMappings, projects } = tables;

export interface SlashCommand {
  command: string;
  text: string;
  userId: string;
  channelId: string;
  channelName?: string;
}

async function isSlackAdmin(slackUserId: string): Promise<boolean> {
  return isAdmin(await getUserBySlackId(slackUserId));
}

async function upsertMapping(
  channelId: string,
  values: { slackChannelName: string; projectId: string | null; clientId: string | null; setByUserId: string | null },
) {
  const row = { ...values, slackChannelId: channelId, source: "slack_command", status: "active" };
  const [existing] = await db
    .select({ id: channelMappings.id })
    .from(channelMappings)
    .where(eq(channelMappings.slackChannelId, channelId))
    .limit(1);
  const [mapping] = existing
    ? await db.update(channelMappings).set(row).where(eq(channelMappings.id, existing.id)).returning()
    : await db.insert(channelMappings).values(row).returning();
  return mapping;
}

async function channelName(command: SlashCommand): Promise<string> {
  return command.channelName ?? (await getChannelInfo(command.channelId))?.name ?? command.channelId;
}

async function mapCompany(command: SlashCommand): Promise<string> {
  const name = await channelName(command);
  const user = await getUserBySlackId(command.userId);
  try {
    await upsertMapping(command.channelId, { slackChannelName: name, projectId: null, clientId: null, setByUserId: user?.id ?? null });
    return `Zmapowano #${name} jako kanał firmowy (\`internal\`).`;
  } catch (error) {
    return `Nie udało się zapisać mappingu: ${(error as Error).message}`;
  }
}

async function mapProject(command: SlashCommand, slug: string, clientId: string | null): Promise<string> {
  const name = await channelName(command);
  const user = await getUserBySlackId(command.userId);
  const [project] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  if (!project) return `Nie ma projektu \`${slug}\`. Utwórz go najpierw w \`/admin/access\`.`;
  const normalized = clientId === null || clientId === "-" || clientId === "internal" ? null : clientId;
  try {
    const mapping = await upsertMapping(command.channelId, {
      slackChannelName: name,
      projectId: project.id,
      clientId: normalized,
      setByUserId: user?.id ?? null,
    });
    const access = mapping.clientId ? `internal + external/${mapping.clientId}` : "internal";
    return `Zmapowano #${name} -> \`${slug}\` (\`${access}\`).`;
  } catch (error) {
    return `Nie udało się zapisać mappingu: ${(error as Error).message}`;
  }
}

async function mappingStatus(): Promise<string> {
  const mappings = await db.select().from(channelMappings).orderBy(asc(channelMappings.status), asc(channelMappings.slackChannelName));
  if (mappings.length === 0) {
    return "*Manfrod — mapowania kanałów*\n\nBrak zmapowanych kanałów. Kanały `av-x-*` są wykrywane automatycznie.";
  }
  const lines = mappings.map((mapping) => {
    const icon = mapping.status === "active" ? "🟢" : "🟡";
    const access = mapping.clientId ? `internal + external/${mapping.clientId}` : "internal";
    return `${icon} *#${mapping.slackChannelName}* → \`${access}\` (${mapping.source})`;
  });
  return `*Manfrod — mapowania kanałów*\n\n${lines.join("\n")}\n\nZarządzaj przez \`/admin/access\` w panelu webowym.`;
}

async function statusCommand(command: SlashCommand): Promise<string> {
  const parts = command.text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return mappingStatus();
  if (parts[0] === "map" && parts[1] === "company" && parts.length === 2) return mapCompany(command);
  if (parts[0] === "map" && parts.length === 2) return mapProject(command, parts[1], null);
  if (parts[0] === "map" && parts.length === 3) return mapProject(command, parts[1], parts[2]);
  return "Użycie: `/status-manfrod`, `/status-manfrod map company` albo `/status-manfrod map <project_slug> [client_id]`.";
}

const ADD_USER_USAGE = "Użycie: `/add-user @osoba email@domena.pl`";

async function addUserCommand(command: SlashCommand): Promise<string> {
  const target = /<@([A-Z0-9]+)(?:\|[^>]*)?>/.exec(command.text)?.[1];
  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(command.text)?.[0];
  if (!target || !email) {
    return `${ADD_USER_USAGE} — oznacz osobę prawdziwym @mention i podaj adres email. Jeśli mention nie jest rozpoznawany, włącz "Escape channels, users, and links" w konfiguracji komendy w Slack.`;
  }
  const existing = await getUserBySlackId(target);
  if (existing) return `<@${target}> już jest w bazie (${existing.name ?? "bez imienia"}, ${existing.email ?? "bez maila"}).`;
  const name = (await fetchUserInfo(target))?.name ?? null;
  const dm = await openDm(target);
  if (!dm) return `Nie udało się otworzyć DM z <@${target}> (:error) — nie dodałem.`;
  try {
    const user = await findOrCreateBySlackId(target, dm, name, email);
    return `Dodałem <@${target}> (${user.name ?? "bez imienia"}, ${user.email}) do bazy.`;
  } catch (error) {
    return `Nie udało się dodać użytkownika: ${(error as Error).message}`;
  }
}

export async function handleSlashCommand(command: SlashCommand): Promise<void> {
  switch (command.command) {
    case "/status-manfrod": {
      const text = (await isSlackAdmin(command.userId)) ? await statusCommand(command) : "Tylko admin może używać `/status-manfrod`.";
      await post("chat.postMessage", { channel: command.channelId, text });
      return;
    }
    case "/add-user": {
      const text = (await isSlackAdmin(command.userId)) ? await addUserCommand(command) : "Tylko admin może używać `/add-user`.";
      await post("chat.postMessage", { channel: command.channelId, text });
      return;
    }
    case "/linear-status": {
      const mapping = await getActiveMapping(command.channelId);
      if (mapping?.project) {
        await postStatus(command.channelId, command.userId, mapping.project);
      } else {
        await post("chat.postEphemeral", {
          channel: command.channelId,
          user: command.userId,
          text: "`/linear-status` działa tylko na kanałach zmapowanych do projektu.",
        });
      }
      return;
    }
  }
}
