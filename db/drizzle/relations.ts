import { relations } from "drizzle-orm/relations";
import { conversations, nodes, projects, users, recurringReminders, links, auditEvents, messages, desks, deskReservations, projectMemberships, facts, mcpCustomProviders, googleIdentities, userTokens, channelMappings, mcpConnections, usageDailyRollups, activityDailyRollups, threadKicks, messageFeedback, kalafiorniaConnections, projectLinearConnections, agentSecrets, session, account } from "./schema";

export const nodesRelations = relations(nodes, ({one, many}) => ({
	conversation: one(conversations, {
		fields: [nodes.conversationId],
		references: [conversations.id]
	}),
	project: one(projects, {
		fields: [nodes.projectId],
		references: [projects.id]
	}),
	user: one(users, {
		fields: [nodes.userId],
		references: [users.id],
		relationName: "nodes_userId_users_id"
	}),
	links_nodeAId: many(links, {
		relationName: "links_nodeAId_nodes_id"
	}),
	links_nodeBId: many(links, {
		relationName: "links_nodeBId_nodes_id"
	}),
	users: many(users, {
		relationName: "users_soulNodeId_nodes_id"
	}),
}));

export const conversationsRelations = relations(conversations, ({one, many}) => ({
	nodes: many(nodes),
	messages: many(messages),
	user: one(users, {
		fields: [conversations.userId],
		references: [users.id]
	}),
}));

export const projectsRelations = relations(projects, ({many}) => ({
	nodes: many(nodes),
	projectMemberships: many(projectMemberships),
	channelMappings: many(channelMappings),
	projectLinearConnections: many(projectLinearConnections),
}));

export const usersRelations = relations(users, ({one, many}) => ({
	nodes: many(nodes, {
		relationName: "nodes_userId_users_id"
	}),
	recurringReminders: many(recurringReminders),
	auditEvents: many(auditEvents),
	messages: many(messages),
	conversations: many(conversations),
	deskReservations: many(deskReservations),
	projectMemberships: many(projectMemberships),
	facts: many(facts),
	mcpCustomProviders: many(mcpCustomProviders),
	googleIdentities: many(googleIdentities),
	userTokens: many(userTokens),
	channelMappings: many(channelMappings),
	mcpConnections: many(mcpConnections),
	usageDailyRollups: many(usageDailyRollups),
	activityDailyRollups: many(activityDailyRollups),
	threadKicks: many(threadKicks),
	messageFeedbacks: many(messageFeedback),
	kalafiorniaConnections: many(kalafiorniaConnections),
	projectLinearConnections: many(projectLinearConnections),
	agentSecrets: many(agentSecrets),
	node: one(nodes, {
		fields: [users.soulNodeId],
		references: [nodes.id],
		relationName: "users_soulNodeId_nodes_id"
	}),
	sessions: many(session),
	accounts: many(account),
}));

export const recurringRemindersRelations = relations(recurringReminders, ({one}) => ({
	user: one(users, {
		fields: [recurringReminders.userId],
		references: [users.id]
	}),
}));

export const linksRelations = relations(links, ({one}) => ({
	node_nodeAId: one(nodes, {
		fields: [links.nodeAId],
		references: [nodes.id],
		relationName: "links_nodeAId_nodes_id"
	}),
	node_nodeBId: one(nodes, {
		fields: [links.nodeBId],
		references: [nodes.id],
		relationName: "links_nodeBId_nodes_id"
	}),
}));

export const auditEventsRelations = relations(auditEvents, ({one}) => ({
	user: one(users, {
		fields: [auditEvents.userId],
		references: [users.id]
	}),
}));

export const messagesRelations = relations(messages, ({one}) => ({
	conversation: one(conversations, {
		fields: [messages.conversationId],
		references: [conversations.id]
	}),
	user: one(users, {
		fields: [messages.userId],
		references: [users.id]
	}),
}));

export const deskReservationsRelations = relations(deskReservations, ({one}) => ({
	desk: one(desks, {
		fields: [deskReservations.deskId],
		references: [desks.id]
	}),
	user: one(users, {
		fields: [deskReservations.userId],
		references: [users.id]
	}),
}));

export const desksRelations = relations(desks, ({many}) => ({
	deskReservations: many(deskReservations),
}));

export const projectMembershipsRelations = relations(projectMemberships, ({one}) => ({
	project: one(projects, {
		fields: [projectMemberships.projectId],
		references: [projects.id]
	}),
	user: one(users, {
		fields: [projectMemberships.userId],
		references: [users.id]
	}),
}));

export const factsRelations = relations(facts, ({one}) => ({
	user: one(users, {
		fields: [facts.setByUserId],
		references: [users.id]
	}),
}));

export const mcpCustomProvidersRelations = relations(mcpCustomProviders, ({one}) => ({
	user: one(users, {
		fields: [mcpCustomProviders.userId],
		references: [users.id]
	}),
}));

export const googleIdentitiesRelations = relations(googleIdentities, ({one}) => ({
	user: one(users, {
		fields: [googleIdentities.userId],
		references: [users.id]
	}),
}));

export const userTokensRelations = relations(userTokens, ({one}) => ({
	user: one(users, {
		fields: [userTokens.userId],
		references: [users.id]
	}),
}));

export const channelMappingsRelations = relations(channelMappings, ({one}) => ({
	project: one(projects, {
		fields: [channelMappings.projectId],
		references: [projects.id]
	}),
	user: one(users, {
		fields: [channelMappings.setByUserId],
		references: [users.id]
	}),
}));

export const mcpConnectionsRelations = relations(mcpConnections, ({one}) => ({
	user: one(users, {
		fields: [mcpConnections.userId],
		references: [users.id]
	}),
}));

export const usageDailyRollupsRelations = relations(usageDailyRollups, ({one}) => ({
	user: one(users, {
		fields: [usageDailyRollups.userId],
		references: [users.id]
	}),
}));

export const activityDailyRollupsRelations = relations(activityDailyRollups, ({one}) => ({
	user: one(users, {
		fields: [activityDailyRollups.userId],
		references: [users.id]
	}),
}));

export const threadKicksRelations = relations(threadKicks, ({one}) => ({
	user: one(users, {
		fields: [threadKicks.userId],
		references: [users.id]
	}),
}));

export const messageFeedbackRelations = relations(messageFeedback, ({one}) => ({
	user: one(users, {
		fields: [messageFeedback.userId],
		references: [users.id]
	}),
}));

export const kalafiorniaConnectionsRelations = relations(kalafiorniaConnections, ({one}) => ({
	user: one(users, {
		fields: [kalafiorniaConnections.userId],
		references: [users.id]
	}),
}));

export const projectLinearConnectionsRelations = relations(projectLinearConnections, ({one}) => ({
	user: one(users, {
		fields: [projectLinearConnections.connectedByUserId],
		references: [users.id]
	}),
	project: one(projects, {
		fields: [projectLinearConnections.projectId],
		references: [projects.id]
	}),
}));

export const agentSecretsRelations = relations(agentSecrets, ({one}) => ({
	user: one(users, {
		fields: [agentSecrets.updatedByUserId],
		references: [users.id]
	}),
}));

export const sessionRelations = relations(session, ({one}) => ({
	user: one(users, {
		fields: [session.userId],
		references: [users.id]
	}),
}));

export const accountRelations = relations(account, ({one}) => ({
	user: one(users, {
		fields: [account.userId],
		references: [users.id]
	}),
}));