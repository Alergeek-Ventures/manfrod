import { pgTable, type AnyPgColumn, index, foreignKey, uuid, text, vector, timestamp, varchar, uniqueIndex, boolean, jsonb, date, integer, bigint, numeric, bigserial, check, primaryKey, pgSequence, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { bytea } from "../../lib/db/types.ts"

export const obanJobState = pgEnum("oban_job_state", ['available', 'scheduled', 'executing', 'retryable', 'completed', 'discarded', 'cancelled'])

export const obanJobsIdSeq = pgSequence("oban_jobs_id_seq", {  startWith: "1", increment: "1", minValue: "1", maxValue: "9223372036854775807", cache: "1", cycle: false })

export const nodes = pgTable("nodes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	content: text().notNull(),
	embedding: vector({ dimensions: 1024 }),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	conversationId: uuid("conversation_id"),
	processedAt: timestamp("processed_at", { mode: 'date' }),
	userId: uuid("user_id").notNull(),
	access: varchar({ length: 255 }).array().default(sql`ARRAY['internal']::varchar[]`).notNull(),
	projectId: uuid("project_id"),
}, (table) => [
	index("nodes_access_gin_idx").using("gin", table.access.asc().nullsLast().op("array_ops")),
	index("nodes_bm25_idx").using("bm25", table.id.asc().nullsLast().op("anyelement_bm25_ops"), table.content.asc().nullsLast().op("anyelement_bm25_ops"), table.userId.asc().nullsLast().op("anyelement_bm25_ops"), table.access.asc().nullsLast().op("anyelement_bm25_ops")).with({key_field: "id"}),
	index().using("btree", table.conversationId.asc().nullsLast().op("uuid_ops")),
	index("nodes_embedding_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index().using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
	index("nodes_slipbox_idx").using("btree", table.insertedAt.asc().nullsLast().op("timestamp_ops")).where(sql`(processed_at IS NULL)`),
	index("nodes_slipbox_user_inserted_at_index").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.insertedAt.asc().nullsLast().op("timestamp_ops")).where(sql`(processed_at IS NULL)`),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const recurringReminders = pgTable("recurring_reminders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	cron: varchar({ length: 255 }).notNull(),
	timezone: varchar({ length: 255 }).default('Europe/Warsaw').notNull(),
	enabled: boolean().default(true).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	userId: uuid("user_id").notNull(),
	instructions: text().notNull(),
}, (table) => [
	index().using("btree", table.enabled.asc().nullsLast().op("bool_ops")),
	uniqueIndex().using("btree", table.name.asc().nullsLast().op("text_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const links = pgTable("links", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	nodeAId: uuid("node_a_id").notNull(),
	nodeBId: uuid("node_b_id").notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	context: text(),
}, (table) => [
	index().using("btree", table.nodeAId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex().using("btree", table.nodeAId.asc().nullsLast().op("uuid_ops"), table.nodeBId.asc().nullsLast().op("uuid_ops")),
	index().using("btree", table.nodeBId.asc().nullsLast().op("uuid_ops")),
]);

export const auditEvents = pgTable("audit_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	type: varchar({ length: 255 }).notNull(),
	source: varchar({ length: 255 }),
	meta: jsonb().default({}),
	timestamp: timestamp({ mode: 'date' }).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	userId: uuid("user_id"),
}, (table) => [
	index().using("btree", table.timestamp.asc().nullsLast().op("timestamp_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const messages = pgTable("messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: uuid("conversation_id"),
	role: varchar({ length: 255 }).notNull(),
	content: text().notNull(),
	receivedAt: timestamp("received_at", { mode: 'date' }).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	userId: uuid("user_id").notNull(),
	sessionKey: text("session_key").notNull(),
}, (table) => [
	index().using("btree", table.conversationId.asc().nullsLast().op("uuid_ops")),
	index("messages_pending_idx").using("btree", table.receivedAt.asc().nullsLast().op("timestamp_ops")).where(sql`(conversation_id IS NULL)`),
	index("messages_pending_user_session_index").using("btree", table.userId.asc().nullsLast().op("timestamp_ops"), table.sessionKey.asc().nullsLast().op("text_ops"), table.receivedAt.asc().nullsLast().op("uuid_ops")).where(sql`(conversation_id IS NULL)`),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const conversations = pgTable("conversations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	startedAt: timestamp("started_at", { mode: 'date' }).notNull(),
	endedAt: timestamp("ended_at", { mode: 'date' }).notNull(),
	summary: text().notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	userId: uuid("user_id").notNull(),
	sessionKey: text("session_key").notNull(),
	access: varchar({ length: 255 }).array().default(sql`ARRAY['internal']::varchar[]`).notNull(),
	slackChannelId: varchar("slack_channel_id", { length: 255 }),
}, (table) => [
	index().using("btree", table.slackChannelId.asc().nullsLast().op("text_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.sessionKey.asc().nullsLast().op("uuid_ops")),
]);

export const deskReservations = pgTable("desk_reservations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	deskId: uuid("desk_id").notNull(),
	userId: uuid("user_id").notNull(),
	date: date().notNull(),
	note: varchar({ length: 255 }),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.deskId.asc().nullsLast().op("date_ops"), table.date.asc().nullsLast().op("uuid_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("date_ops"), table.date.asc().nullsLast().op("date_ops")),
]);

export const projects = pgTable("projects", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 255 }).notNull(),
	name: varchar({ length: 255 }).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.slug.asc().nullsLast().op("text_ops")),
]);

export const projectMemberships = pgTable("project_memberships", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	projectId: uuid("project_id").notNull(),
	source: varchar({ length: 255 }).default('auto_detected').notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	removedAt: timestamp("removed_at", { mode: 'date' }),
}, (table) => [
	index().using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex().using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.projectId.asc().nullsLast().op("uuid_ops")),
]);

export const facts = pgTable("facts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	key: varchar({ length: 255 }).notNull(),
	value: text().notNull(),
	access: varchar({ length: 255 }).array().default(sql`ARRAY['internal']::varchar[]`).notNull(),
	setByUserId: uuid("set_by_user_id"),
	validFrom: timestamp("valid_from", { mode: 'date' }),
	validUntil: timestamp("valid_until", { mode: 'date' }),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("gin", table.access.asc().nullsLast().op("array_ops")),
	index().using("btree", table.key.asc().nullsLast().op("text_ops")),
	index().using("btree", table.validFrom.asc().nullsLast().op("timestamp_ops"), table.validUntil.asc().nullsLast().op("timestamp_ops")),
]);

export const mcpCustomProviders = pgTable("mcp_custom_providers", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	url: text().notNull(),
	name: text(),
	logoUrl: text("logo_url"),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	scope: text(),
}, (table) => [
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const mcpOauthClients = pgTable("mcp_oauth_clients", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	provider: text().notNull(),
	clientId: text("client_id").notNull(),
	clientSecret: text("client_secret"),
	authorizationEndpoint: text("authorization_endpoint").notNull(),
	tokenEndpoint: text("token_endpoint").notNull(),
	registrationEndpoint: text("registration_endpoint"),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.provider.asc().nullsLast().op("text_ops")),
]);

export const googleIdentities = pgTable("google_identities", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	googleSub: varchar("google_sub", { length: 255 }).notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	tokenExpiresAt: integer("token_expires_at"),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.googleSub.asc().nullsLast().op("text_ops")),
	uniqueIndex().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const userTokens = pgTable("user_tokens", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	token: bytea("token").notNull(),
	context: varchar({ length: 255 }).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.context.asc().nullsLast().op("text_ops"), table.token.asc().nullsLast().op("text_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const channelMappings = pgTable("channel_mappings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
	slackChannelName: varchar("slack_channel_name", { length: 255 }),
	projectId: uuid("project_id"),
	clientId: varchar("client_id", { length: 255 }),
	source: varchar({ length: 255 }).notNull(),
	status: varchar({ length: 255 }).default('active').notNull(),
	setByUserId: uuid("set_by_user_id"),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex().using("btree", table.slackChannelId.asc().nullsLast().op("text_ops")),
	index().using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const desks = pgTable("desks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	label: varchar({ length: 255 }).notNull(),
	locationNote: varchar("location_note", { length: 255 }),
	equipment: varchar({ length: 255 }).array().default(sql`ARRAY[]::varchar[]`).notNull(),
	mapX: integer("map_x"),
	mapY: integer("map_y"),
	permanentOwner: varchar("permanent_owner", { length: 255 }),
	active: boolean().default(true).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("btree", table.active.asc().nullsLast().op("bool_ops")),
	uniqueIndex().using("btree", table.label.asc().nullsLast().op("text_ops")),
]);

export const mcpConnections = pgTable("mcp_connections", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	provider: text().notNull(),
	status: text().default('connected').notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	expiresAt: timestamp("expires_at", { mode: 'date' }),
	scope: text(),
	notifiedExpiredAt: timestamp("notified_expired_at", { mode: 'date' }),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.userId.asc().nullsLast().op("text_ops"), table.provider.asc().nullsLast().op("text_ops")),
]);

export const usageDailyRollups = pgTable("usage_daily_rollups", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	date: date().notNull(),
	userId: uuid("user_id"),
	model: varchar({ length: 255 }).notNull(),
	purpose: varchar({ length: 255 }).notNull(),
	provider: varchar({ length: 255 }),
	tier: varchar({ length: 255 }),
	calls: integer().default(0).notNull(),
	failedCalls: integer("failed_calls").default(0).notNull(),
	retries: integer().default(0).notNull(),
	fallbacks: integer().default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cachedTokens: bigint("cached_tokens", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }).default(0).notNull(),
	costUsd: numeric("cost_usd", { precision: 14, scale:  8 }).default('0').notNull(),
	uncachedCostUsd: numeric("uncached_cost_usd", { precision: 14, scale:  8 }).default('0').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalLatencyMs: bigint("total_latency_ms", { mode: "number" }).default(0).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("btree", table.date.asc().nullsLast().op("date_ops")),
	uniqueIndex("usage_daily_rollups_grain_index").using("btree", table.date.asc().nullsLast().op("date_ops"), table.userId.asc().nullsLast().op("date_ops"), table.model.asc().nullsLast().op("date_ops"), table.purpose.asc().nullsLast().op("date_ops")),
	index().using("btree", table.model.asc().nullsLast().op("text_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const activityDailyRollups = pgTable("activity_daily_rollups", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	date: date().notNull(),
	userId: uuid("user_id"),
	messagesReceived: integer("messages_received").default(0).notNull(),
	messagesSent: integer("messages_sent").default(0).notNull(),
	toolCalls: integer("tool_calls").default(0).notNull(),
	sessions: integer().default(0).notNull(),
	memorySearches: integer("memory_searches").default(0).notNull(),
	notesCreated: integer("notes_created").default(0).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("btree", table.date.asc().nullsLast().op("date_ops")),
	uniqueIndex("activity_daily_rollups_grain_index").using("btree", table.date.asc().nullsLast().op("date_ops"), table.userId.asc().nullsLast().op("date_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const threadKicks = pgTable("thread_kicks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
	threadTs: varchar("thread_ts", { length: 255 }).notNull(),
	userId: uuid("user_id"),
	slackUserId: varchar("slack_user_id", { length: 255 }),
	source: varchar({ length: 255 }).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.slackChannelId.asc().nullsLast().op("text_ops"), table.threadTs.asc().nullsLast().op("text_ops")),
]);

export const toolDailyRollups = pgTable("tool_daily_rollups", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	date: date().notNull(),
	tool: varchar({ length: 255 }).notNull(),
	calls: integer().default(0).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("btree", table.date.asc().nullsLast().op("date_ops")),
	uniqueIndex("tool_daily_rollups_grain_index").using("btree", table.date.asc().nullsLast().op("date_ops"), table.tool.asc().nullsLast().op("date_ops")),
	index().using("btree", table.tool.asc().nullsLast().op("text_ops")),
]);

export const messageFeedback = pgTable("message_feedback", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id"),
	slackUserId: varchar("slack_user_id", { length: 255 }),
	slackUserName: varchar("slack_user_name", { length: 255 }),
	slackChannelId: varchar("slack_channel_id", { length: 255 }).notNull(),
	slackChannelName: varchar("slack_channel_name", { length: 255 }),
	messageTs: varchar("message_ts", { length: 255 }).notNull(),
	sessionKey: varchar("session_key", { length: 255 }),
	rating: varchar({ length: 255 }).notNull(),
	permalink: varchar({ length: 255 }),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("btree", table.insertedAt.asc().nullsLast().op("timestamp_ops")),
	uniqueIndex("message_feedback_rater_index").using("btree", table.slackChannelId.asc().nullsLast().op("text_ops"), table.messageTs.asc().nullsLast().op("text_ops"), table.slackUserId.asc().nullsLast().op("text_ops")),
	index().using("btree", table.rating.asc().nullsLast().op("text_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const kalafiorniaConnections = pgTable("kalafiornia_connections", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	email: text().notNull(),
	session: text().notNull(),
	status: text().default('connected').notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const projectLinearConnections = pgTable("project_linear_connections", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	apiKey: bytea("api_key"),
	status: text().default('connected').notNull(),
	linearTeamId: text("linear_team_id"),
	linearTeamName: text("linear_team_name"),
	connectedByUserId: uuid("connected_by_user_id"),
	disconnectedAt: timestamp("disconnected_at", { mode: 'date' }),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	installationId: uuid("installation_id"),
}, (table) => [
	uniqueIndex().using("btree", table.projectId.asc().nullsLast().op("uuid_ops")),
]);

export const linearInstallations = pgTable("linear_installations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	organizationId: text("organization_id").notNull(),
	organizationName: text("organization_name"),
	appUserId: text("app_user_id"),
	accessToken: bytea("access_token").notNull(),
	refreshToken: bytea("refresh_token"),
	expiresAt: timestamp("expires_at", { mode: 'date' }),
	scope: text(),
	status: text().default('connected').notNull(),
	installedByUserId: uuid("installed_by_user_id"),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.organizationId.asc().nullsLast().op("text_ops")),
]);

export const jobs = pgTable("jobs", {
	id: bigserial({ mode: "number" }).primaryKey().notNull(),
	kind: text().notNull(),
	args: jsonb().default({}).notNull(),
	meta: jsonb().default({}).notNull(),
	state: text().default('scheduled').notNull(),
	scheduledAt: timestamp("scheduled_at", { mode: 'date' }).notNull(),
	uniqueKey: text("unique_key"),
	attempt: integer().default(0).notNull(),
	maxAttempts: integer("max_attempts").default(3).notNull(),
	lastError: text("last_error"),
	lockedUntil: timestamp("locked_until", { mode: 'date' }),
	completedAt: timestamp("completed_at", { mode: 'date' }),
	dispatchedAt: timestamp("dispatched_at", { mode: 'date' }),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("gin", table.args.asc().nullsLast().op("jsonb_ops")),
	index("jobs_due_index").using("btree", table.state.asc().nullsLast().op("timestamp_ops"), table.scheduledAt.asc().nullsLast().op("text_ops")),
	index().using("btree", table.kind.asc().nullsLast().op("text_ops")),
	uniqueIndex().using("btree", table.uniqueKey.asc().nullsLast().op("text_ops")),
]);

export const memoryBuffer = pgTable("memory_buffer", {
	id: bigserial({ mode: "number" }).primaryKey().notNull(),
	channelId: text("channel_id").notNull(),
	threadTs: text("thread_ts"),
	channelName: text("channel_name"),
	message: jsonb().notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	claimedAt: timestamp("claimed_at", { mode: 'date' }),
	attempts: integer().default(0).notNull(),
}, (table) => [
	index("memory_buffer_key_index").using("btree", table.channelId.asc().nullsLast().op("text_ops"), table.threadTs.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("text_ops")),
]);

export const memoryPendingConfirmations = pgTable("memory_pending_confirmations", {
	botTs: text("bot_ts").primaryKey().notNull(),
	channelId: text("channel_id").notNull(),
	payload: jsonb().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'date' }).notNull(),
});

export const agentSecrets = pgTable("agent_secrets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	value: bytea("value").notNull(),
	description: text(),
	updatedByUserId: uuid("updated_by_user_id"),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex().using("btree", table.name.asc().nullsLast().op("text_ops")),
	check("agent_secrets_name_format", sql`name ~ '^[A-Z][A-Z0-9_]{1,63}$'::text`),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slackId: text("slack_id").notNull(),
	name: text(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	slackDmChannelId: text("slack_dm_channel_id").notNull(),
	email: varchar({ length: 255 }),
	soulNodeId: uuid("soul_node_id"),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text(),
	role: text().default('user'),
	banned: boolean().default(false),
	banReason: text("ban_reason"),
	banExpires: timestamp("ban_expires", { precision: 3, mode: 'date' }),
}, (table) => [
	uniqueIndex().using("btree", table.email.asc().nullsLast().op("text_ops")),
	uniqueIndex().using("btree", table.slackId.asc().nullsLast().op("text_ops")),
	index().using("btree", table.soulNodeId.asc().nullsLast().op("uuid_ops")),
]);

export const session = pgTable("session", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	token: text().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, mode: 'date' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	impersonatedBy: uuid("impersonated_by"),
}, (table) => [
	uniqueIndex().using("btree", table.token.asc().nullsLast().op("text_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const account = pgTable("account", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { precision: 3, mode: 'date' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { precision: 3, mode: 'date' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	uniqueIndex("account_provider_account_index").using("btree", table.providerId.asc().nullsLast().op("text_ops"), table.accountId.asc().nullsLast().op("text_ops")),
	index().using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
]);

export const verification = pgTable("verification", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { precision: 3, mode: 'date' }).notNull(),
	createdAt: timestamp("created_at", { precision: 3, mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
	updatedAt: timestamp("updated_at", { precision: 3, mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	index().using("btree", table.identifier.asc().nullsLast().op("text_ops")),
]);

export const proactiveThreads = pgTable("proactive_threads", {
	channelId: text("channel_id").notNull(),
	threadTs: text("thread_ts").notNull(),
	titled: boolean().default(false).notNull(),
	insertedAt: timestamp("inserted_at", { mode: 'date' }).default(sql`timezone('UTC'::text, now())`).notNull(),
}, (table) => [
	primaryKey({ columns: [table.channelId, table.threadTs], name: "proactive_threads_pkey"}),
]);

export const memoryPendingOps = pgTable("memory_pending_ops", {
	channelId: text("channel_id").notNull(),
	ts: text().notNull(),
	flag: jsonb(),
	ops: jsonb().default([]).notNull(),
	expiresAt: timestamp("expires_at", { mode: 'date' }).notNull(),
}, (table) => [
	primaryKey({ columns: [table.channelId, table.ts], name: "memory_pending_ops_pkey"}),
]);
