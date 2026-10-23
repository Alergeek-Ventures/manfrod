CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
CREATE TABLE activity_daily_rollups (
    id uuid NOT NULL,
    date date NOT NULL,
    user_id uuid,
    messages_received integer DEFAULT 0 NOT NULL,
    messages_sent integer DEFAULT 0 NOT NULL,
    tool_calls integer DEFAULT 0 NOT NULL,
    sessions integer DEFAULT 0 NOT NULL,
    memory_searches integer DEFAULT 0 NOT NULL,
    notes_created integer DEFAULT 0 NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE audit_events (
    id uuid NOT NULL,
    type character varying(255) NOT NULL,
    source character varying(255),
    meta jsonb DEFAULT '{}'::jsonb,
    "timestamp" timestamp without time zone NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    user_id uuid
);

CREATE TABLE channel_mappings (
    id uuid NOT NULL,
    slack_channel_id character varying(255) NOT NULL,
    slack_channel_name character varying(255),
    project_id uuid,
    client_id character varying(255),
    source character varying(255) NOT NULL,
    status character varying(255) DEFAULT 'active'::character varying NOT NULL,
    set_by_user_id uuid,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE conversations (
    id uuid NOT NULL,
    started_at timestamp(0) without time zone NOT NULL,
    ended_at timestamp(0) without time zone NOT NULL,
    summary text NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    user_id uuid NOT NULL,
    session_key text NOT NULL,
    access character varying(255)[] DEFAULT ARRAY['internal'::character varying] NOT NULL,
    slack_channel_id character varying(255)
);

CREATE TABLE desk_reservations (
    id uuid NOT NULL,
    desk_id uuid NOT NULL,
    user_id uuid NOT NULL,
    date date NOT NULL,
    note character varying(255),
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE desks (
    id uuid NOT NULL,
    label character varying(255) NOT NULL,
    location_note character varying(255),
    equipment character varying(255)[] DEFAULT ARRAY[]::character varying[] NOT NULL,
    map_x integer,
    map_y integer,
    permanent_owner character varying(255),
    active boolean DEFAULT true NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE facts (
    id uuid NOT NULL,
    key character varying(255) NOT NULL,
    value text NOT NULL,
    access character varying(255)[] DEFAULT ARRAY['internal'::character varying] NOT NULL,
    set_by_user_id uuid,
    valid_from timestamp(0) without time zone,
    valid_until timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE google_identities (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    google_sub character varying(255) NOT NULL,
    access_token text,
    refresh_token text,
    token_expires_at integer,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE kalafiornia_connections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    email text NOT NULL,
    session text NOT NULL,
    status text DEFAULT 'connected'::text NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE links (
    id uuid NOT NULL,
    node_a_id uuid NOT NULL,
    node_b_id uuid NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    context text
);

CREATE TABLE mcp_connections (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    status text DEFAULT 'connected'::text NOT NULL,
    access_token text,
    refresh_token text,
    expires_at timestamp(0) without time zone,
    scope text,
    notified_expired_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE mcp_custom_providers (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    url text NOT NULL,
    name text,
    logo_url text,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE mcp_oauth_clients (
    id uuid NOT NULL,
    provider text NOT NULL,
    client_id text NOT NULL,
    client_secret text,
    authorization_endpoint text NOT NULL,
    token_endpoint text NOT NULL,
    registration_endpoint text,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE message_feedback (
    id uuid NOT NULL,
    user_id uuid,
    slack_user_id character varying(255),
    slack_user_name character varying(255),
    slack_channel_id character varying(255) NOT NULL,
    slack_channel_name character varying(255),
    message_ts character varying(255) NOT NULL,
    session_key character varying(255),
    rating character varying(255) NOT NULL,
    permalink character varying(255),
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE messages (
    id uuid NOT NULL,
    conversation_id uuid,
    role character varying(255) NOT NULL,
    content text NOT NULL,
    received_at timestamp(0) without time zone NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    user_id uuid NOT NULL,
    session_key text NOT NULL
);

CREATE TABLE nodes (
    id uuid NOT NULL,
    content text NOT NULL,
    embedding vector(1024),
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    conversation_id uuid,
    processed_at timestamp(0) without time zone,
    user_id uuid NOT NULL,
    access character varying(255)[] DEFAULT ARRAY['internal'::character varying] NOT NULL,
    project_id uuid
);

CREATE TABLE project_linear_connections (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    api_key bytea,
    status text DEFAULT 'connected'::text NOT NULL,
    linear_team_id text,
    linear_team_name text,
    connected_by_user_id uuid,
    disconnected_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE project_memberships (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    project_id uuid NOT NULL,
    source character varying(255) DEFAULT 'auto_detected'::character varying NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE projects (
    id uuid NOT NULL,
    slug character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE recurring_reminders (
    id uuid NOT NULL,
    name character varying(255) NOT NULL,
    cron character varying(255) NOT NULL,
    timezone character varying(255) DEFAULT 'Europe/Warsaw'::character varying NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    user_id uuid NOT NULL,
    instructions text NOT NULL
);

CREATE TABLE thread_kicks (
    id uuid NOT NULL,
    slack_channel_id character varying(255) NOT NULL,
    thread_ts character varying(255) NOT NULL,
    user_id uuid,
    slack_user_id character varying(255),
    source character varying(255) NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE tool_daily_rollups (
    id uuid NOT NULL,
    date date NOT NULL,
    tool character varying(255) NOT NULL,
    calls integer DEFAULT 0 NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE usage_daily_rollups (
    id uuid NOT NULL,
    date date NOT NULL,
    user_id uuid,
    model character varying(255) NOT NULL,
    purpose character varying(255) NOT NULL,
    provider character varying(255),
    tier character varying(255),
    calls integer DEFAULT 0 NOT NULL,
    failed_calls integer DEFAULT 0 NOT NULL,
    retries integer DEFAULT 0 NOT NULL,
    fallbacks integer DEFAULT 0 NOT NULL,
    input_tokens bigint DEFAULT 0 NOT NULL,
    output_tokens bigint DEFAULT 0 NOT NULL,
    cached_tokens bigint DEFAULT 0 NOT NULL,
    cache_creation_tokens bigint DEFAULT 0 NOT NULL,
    cost_usd numeric(14,8) DEFAULT 0 NOT NULL,
    uncached_cost_usd numeric(14,8) DEFAULT 0 NOT NULL,
    total_latency_ms bigint DEFAULT 0 NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE user_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token bytea NOT NULL,
    context character varying(255) NOT NULL,
    inserted_at timestamp(0) without time zone NOT NULL
);

CREATE TABLE users (
    id uuid NOT NULL,
    slack_id text NOT NULL,
    name text,
    inserted_at timestamp(0) without time zone NOT NULL,
    updated_at timestamp(0) without time zone NOT NULL,
    slack_dm_channel_id text NOT NULL,
    email character varying(255),
    soul_node_id uuid
);

ALTER TABLE ONLY activity_daily_rollups
    ADD CONSTRAINT activity_daily_rollups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY channel_mappings
    ADD CONSTRAINT channel_mappings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY desk_reservations
    ADD CONSTRAINT desk_reservations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY desks
    ADD CONSTRAINT desks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY facts
    ADD CONSTRAINT facts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY google_identities
    ADD CONSTRAINT google_identities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY kalafiornia_connections
    ADD CONSTRAINT kalafiornia_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY links
    ADD CONSTRAINT links_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mcp_connections
    ADD CONSTRAINT mcp_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mcp_custom_providers
    ADD CONSTRAINT mcp_custom_providers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY mcp_oauth_clients
    ADD CONSTRAINT mcp_oauth_clients_pkey PRIMARY KEY (id);

ALTER TABLE ONLY message_feedback
    ADD CONSTRAINT message_feedback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY project_linear_connections
    ADD CONSTRAINT project_linear_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY project_memberships
    ADD CONSTRAINT project_memberships_pkey PRIMARY KEY (id);

ALTER TABLE ONLY projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);

ALTER TABLE ONLY recurring_reminders
    ADD CONSTRAINT recurring_reminders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY thread_kicks
    ADD CONSTRAINT thread_kicks_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tool_daily_rollups
    ADD CONSTRAINT tool_daily_rollups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY usage_daily_rollups
    ADD CONSTRAINT usage_daily_rollups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY user_tokens
    ADD CONSTRAINT user_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX activity_daily_rollups_date_index ON activity_daily_rollups USING btree (date);

CREATE UNIQUE INDEX activity_daily_rollups_grain_index ON activity_daily_rollups USING btree (date, user_id) NULLS NOT DISTINCT;

CREATE INDEX activity_daily_rollups_user_id_index ON activity_daily_rollups USING btree (user_id);

CREATE INDEX audit_events_timestamp_index ON audit_events USING btree ("timestamp");

CREATE INDEX audit_events_user_id_index ON audit_events USING btree (user_id);

CREATE INDEX channel_mappings_project_id_index ON channel_mappings USING btree (project_id);

CREATE UNIQUE INDEX channel_mappings_slack_channel_id_index ON channel_mappings USING btree (slack_channel_id);

CREATE INDEX channel_mappings_status_index ON channel_mappings USING btree (status);

CREATE INDEX conversations_slack_channel_id_index ON conversations USING btree (slack_channel_id);

CREATE INDEX conversations_user_id_index ON conversations USING btree (user_id);

CREATE INDEX conversations_user_id_session_key_index ON conversations USING btree (user_id, session_key);

CREATE UNIQUE INDEX desk_reservations_desk_id_date_index ON desk_reservations USING btree (desk_id, date);

CREATE INDEX desk_reservations_user_id_date_index ON desk_reservations USING btree (user_id, date);

CREATE INDEX desks_active_index ON desks USING btree (active);

CREATE UNIQUE INDEX desks_label_index ON desks USING btree (label);

CREATE INDEX facts_access_index ON facts USING gin (access);

CREATE INDEX facts_key_index ON facts USING btree (key);

CREATE INDEX facts_valid_from_valid_until_index ON facts USING btree (valid_from, valid_until);

CREATE UNIQUE INDEX google_identities_google_sub_index ON google_identities USING btree (google_sub);

CREATE UNIQUE INDEX google_identities_user_id_index ON google_identities USING btree (user_id);

CREATE UNIQUE INDEX kalafiornia_connections_user_id_index ON kalafiornia_connections USING btree (user_id);

CREATE INDEX links_node_a_id_index ON links USING btree (node_a_id);

CREATE UNIQUE INDEX links_node_a_id_node_b_id_index ON links USING btree (node_a_id, node_b_id);

CREATE INDEX links_node_b_id_index ON links USING btree (node_b_id);

CREATE UNIQUE INDEX mcp_connections_user_id_provider_index ON mcp_connections USING btree (user_id, provider);

CREATE INDEX mcp_custom_providers_user_id_index ON mcp_custom_providers USING btree (user_id);

CREATE UNIQUE INDEX mcp_oauth_clients_provider_index ON mcp_oauth_clients USING btree (provider);

CREATE INDEX message_feedback_inserted_at_index ON message_feedback USING btree (inserted_at);

CREATE UNIQUE INDEX message_feedback_rater_index ON message_feedback USING btree (slack_channel_id, message_ts, slack_user_id) NULLS NOT DISTINCT;

CREATE INDEX message_feedback_rating_index ON message_feedback USING btree (rating);

CREATE INDEX message_feedback_user_id_index ON message_feedback USING btree (user_id);

CREATE INDEX messages_conversation_id_index ON messages USING btree (conversation_id);

CREATE INDEX messages_pending_idx ON messages USING btree (received_at) WHERE (conversation_id IS NULL);

CREATE INDEX messages_pending_user_session_index ON messages USING btree (user_id, session_key, received_at) WHERE (conversation_id IS NULL);

CREATE INDEX messages_user_id_index ON messages USING btree (user_id);

CREATE INDEX nodes_access_gin_idx ON nodes USING gin (access);

CREATE INDEX nodes_bm25_idx ON nodes USING bm25 (id, content, user_id, access) WITH (key_field=id);

CREATE INDEX nodes_conversation_id_index ON nodes USING btree (conversation_id);

CREATE INDEX nodes_embedding_idx ON nodes USING hnsw (embedding vector_cosine_ops);

CREATE INDEX nodes_project_id_index ON nodes USING btree (project_id);

CREATE INDEX nodes_slipbox_idx ON nodes USING btree (inserted_at) WHERE (processed_at IS NULL);

CREATE INDEX nodes_slipbox_user_inserted_at_index ON nodes USING btree (user_id, inserted_at) WHERE (processed_at IS NULL);

CREATE INDEX nodes_user_id_index ON nodes USING btree (user_id);

CREATE UNIQUE INDEX project_linear_connections_project_id_index ON project_linear_connections USING btree (project_id);

CREATE INDEX project_memberships_project_id_index ON project_memberships USING btree (project_id);

CREATE UNIQUE INDEX project_memberships_user_id_project_id_index ON project_memberships USING btree (user_id, project_id);

CREATE UNIQUE INDEX projects_slug_index ON projects USING btree (slug);

CREATE INDEX recurring_reminders_enabled_index ON recurring_reminders USING btree (enabled);

CREATE UNIQUE INDEX recurring_reminders_name_index ON recurring_reminders USING btree (name);

CREATE INDEX recurring_reminders_user_id_index ON recurring_reminders USING btree (user_id);

CREATE UNIQUE INDEX thread_kicks_slack_channel_id_thread_ts_index ON thread_kicks USING btree (slack_channel_id, thread_ts);

CREATE INDEX tool_daily_rollups_date_index ON tool_daily_rollups USING btree (date);

CREATE UNIQUE INDEX tool_daily_rollups_grain_index ON tool_daily_rollups USING btree (date, tool);

CREATE INDEX tool_daily_rollups_tool_index ON tool_daily_rollups USING btree (tool);

CREATE INDEX usage_daily_rollups_date_index ON usage_daily_rollups USING btree (date);

CREATE UNIQUE INDEX usage_daily_rollups_grain_index ON usage_daily_rollups USING btree (date, user_id, model, purpose) NULLS NOT DISTINCT;

CREATE INDEX usage_daily_rollups_model_index ON usage_daily_rollups USING btree (model);

CREATE INDEX usage_daily_rollups_user_id_index ON usage_daily_rollups USING btree (user_id);

CREATE UNIQUE INDEX user_tokens_context_token_index ON user_tokens USING btree (context, token);

CREATE INDEX user_tokens_user_id_index ON user_tokens USING btree (user_id);

CREATE UNIQUE INDEX users_email_index ON users USING btree (email);

CREATE UNIQUE INDEX users_slack_id_index ON users USING btree (slack_id);

CREATE INDEX users_soul_node_id_index ON users USING btree (soul_node_id);

ALTER TABLE ONLY activity_daily_rollups
    ADD CONSTRAINT activity_daily_rollups_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY audit_events
    ADD CONSTRAINT audit_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY channel_mappings
    ADD CONSTRAINT channel_mappings_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY channel_mappings
    ADD CONSTRAINT channel_mappings_set_by_user_id_fkey FOREIGN KEY (set_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY conversations
    ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY desk_reservations
    ADD CONSTRAINT desk_reservations_desk_id_fkey FOREIGN KEY (desk_id) REFERENCES desks(id) ON DELETE CASCADE;

ALTER TABLE ONLY desk_reservations
    ADD CONSTRAINT desk_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY facts
    ADD CONSTRAINT facts_set_by_user_id_fkey FOREIGN KEY (set_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY google_identities
    ADD CONSTRAINT google_identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY kalafiornia_connections
    ADD CONSTRAINT kalafiornia_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY links
    ADD CONSTRAINT links_node_a_id_fkey FOREIGN KEY (node_a_id) REFERENCES nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY links
    ADD CONSTRAINT links_node_b_id_fkey FOREIGN KEY (node_b_id) REFERENCES nodes(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_connections
    ADD CONSTRAINT mcp_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY mcp_custom_providers
    ADD CONSTRAINT mcp_custom_providers_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY message_feedback
    ADD CONSTRAINT message_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY messages
    ADD CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT;

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE ONLY nodes
    ADD CONSTRAINT nodes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY project_linear_connections
    ADD CONSTRAINT project_linear_connections_connected_by_user_id_fkey FOREIGN KEY (connected_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY project_linear_connections
    ADD CONSTRAINT project_linear_connections_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY project_memberships
    ADD CONSTRAINT project_memberships_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE ONLY project_memberships
    ADD CONSTRAINT project_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY recurring_reminders
    ADD CONSTRAINT recurring_reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY thread_kicks
    ADD CONSTRAINT thread_kicks_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY usage_daily_rollups
    ADD CONSTRAINT usage_daily_rollups_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE ONLY user_tokens
    ADD CONSTRAINT user_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY users
    ADD CONSTRAINT users_soul_node_id_fkey FOREIGN KEY (soul_node_id) REFERENCES nodes(id) ON DELETE SET NULL;

INSERT INTO desks (id, label, equipment, location_note, permanent_owner, active, inserted_at, updated_at)
VALUES
  (gen_random_uuid(), 'T1', ARRAY['usb-c'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'T2', ARRAY['hdmi'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'T3', ARRAY['mac_mini'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'T4', ARRAY['hdmi'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'T5', ARRAY['hdmi'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'T6', ARRAY['mac_mini'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'B1', ARRAY['usb-c'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'B2', ARRAY['no_monitor'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'B3', ARRAY['usb-c'], 'zwykle: Staszek', NULL, true, now(), now()),
  (gen_random_uuid(), 'B4', ARRAY['usb-c'], NULL, NULL, true, now(), now()),
  (gen_random_uuid(), 'Agata', ARRAY[]::varchar[], NULL, 'Agata', true, now(), now()),
  (gen_random_uuid(), 'Franek', ARRAY[]::varchar[], NULL, 'Franek', true, now(), now())
ON CONFLICT (label) DO NOTHING;
