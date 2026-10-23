import {
  account,
  agentSecrets,
  auditEvents,
  channelMappings,
  conversations,
  deskReservations,
  desks,
  facts,
  googleIdentities,
  jobs,
  kalafiorniaConnections,
  links,
  mcpConnections,
  mcpCustomProviders,
  mcpOauthClients,
  messageFeedback,
  messages,
  nodes,
  projectLinearConnections,
  projects,
  recurringReminders,
  users,
} from "../../db/drizzle/schema.ts";

export * from "../../db/drizzle/schema.ts";
export * from "../../db/drizzle/relations.ts";

export interface BufferedMessage {
  user: string;
  user_name: string | null;
  text: string;
  ts: string;
}

export type User = typeof users.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type Link = typeof links.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Fact = typeof facts.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ChannelMapping = typeof channelMappings.$inferSelect;
export type RecurringReminder = typeof recurringReminders.$inferSelect;
export type Desk = typeof desks.$inferSelect;
export type DeskReservation = typeof deskReservations.$inferSelect;
export type McpConnection = typeof mcpConnections.$inferSelect;
export type McpCustomProvider = typeof mcpCustomProviders.$inferSelect;
export type McpOauthClient = typeof mcpOauthClients.$inferSelect;
export type GoogleIdentity = typeof googleIdentities.$inferSelect;
export type KalafiorniaConnection = typeof kalafiorniaConnections.$inferSelect;
export type ProjectLinearConnection = typeof projectLinearConnections.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AgentSecret = typeof agentSecrets.$inferSelect;
export type Account = typeof account.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type MessageFeedback = typeof messageFeedback.$inferSelect;
