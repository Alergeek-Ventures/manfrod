import { isAdminEmail } from "../config.ts";
import { getUser } from "../accounts.ts";

export interface MsgCtx {
  channel: string | null;
  ts: string | null;
  threadTs: string | null;
  slackUserId: string | null;
}

export interface ToolCtx {
  userId: string;
  readableLevels: string[];
  writeAccess: string[];
  msgCtx: MsgCtx;
  kind: string;
  sessionKey: string | null;
}

type Attributes = Readonly<Record<string, string | readonly string[]>>;

interface AuthLike {
  readonly attributes: Attributes;
  readonly principalId: string;
}

interface SessionLike {
  readonly session: { readonly auth: { readonly current: AuthLike | null; readonly initiator: AuthLike | null } };
}

const str = (attributes: Attributes, key: string): string | null => {
  const value = attributes[key];
  return typeof value === "string" && value !== "" ? value : null;
};

const list = (attributes: Attributes, key: string): string[] => {
  const value = attributes[key];
  if (Array.isArray(value)) return [...value];
  if (typeof value === "string" && value !== "") return [value];
  return [];
};

export function toolCtxFromAuth(auth: AuthLike | null): ToolCtx {
  const attributes: Attributes = auth?.attributes ?? {};
  const channel = str(attributes, "channelId");
  const threadTs = str(attributes, "threadTs");
  return {
    userId: str(attributes, "userId") ?? auth?.principalId ?? "",
    readableLevels: list(attributes, "readableLevels"),
    writeAccess: list(attributes, "writeAccess"),
    msgCtx: {
      channel,
      ts: str(attributes, "messageTs"),
      threadTs,
      slackUserId: str(attributes, "slackUserId"),
    },
    kind: str(attributes, "kind") ?? "slack",
    sessionKey: channel && threadTs ? `${channel}:${threadTs}` : null,
  };
}

export function toolCtx(ctx: SessionLike): ToolCtx {
  return toolCtxFromAuth(ctx.session.auth.current ?? ctx.session.auth.initiator);
}

export function flaggable(msgCtx: MsgCtx): { channel: string; ts: string } | null {
  return msgCtx.channel && msgCtx.ts ? { channel: msgCtx.channel, ts: msgCtx.ts } : null;
}

export async function requireAdmin(userId: string): Promise<string | null> {
  const user = await getUser(userId);
  return isAdminEmail(user?.email) ? null : "Only an admin can do that.";
}
