CREATE TABLE IF NOT EXISTS jobs (
    id bigserial PRIMARY KEY,
    kind text NOT NULL,
    args jsonb NOT NULL DEFAULT '{}'::jsonb,
    meta jsonb NOT NULL DEFAULT '{}'::jsonb,
    state text NOT NULL DEFAULT 'scheduled',
    scheduled_at timestamp without time zone NOT NULL,
    unique_key text,
    attempt integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 3,
    last_error text,
    locked_until timestamp without time zone,
    completed_at timestamp without time zone,
    dispatched_at timestamp without time zone,
    inserted_at timestamp without time zone NOT NULL DEFAULT timezone('UTC', now())
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_unique_key_index ON jobs (unique_key);
CREATE INDEX IF NOT EXISTS jobs_due_index ON jobs (state, scheduled_at);
CREATE INDEX IF NOT EXISTS jobs_kind_index ON jobs (kind);
CREATE INDEX IF NOT EXISTS jobs_args_index ON jobs USING gin (args);

CREATE TABLE IF NOT EXISTS memory_buffer (
    id bigserial PRIMARY KEY,
    channel_id text NOT NULL,
    thread_ts text,
    channel_name text,
    message jsonb NOT NULL,
    inserted_at timestamp without time zone NOT NULL DEFAULT timezone('UTC', now())
);

CREATE INDEX IF NOT EXISTS memory_buffer_key_index ON memory_buffer (channel_id, thread_ts, id);

CREATE TABLE IF NOT EXISTS memory_pending_ops (
    channel_id text NOT NULL,
    ts text NOT NULL,
    flag jsonb,
    ops jsonb NOT NULL DEFAULT '[]'::jsonb,
    expires_at timestamp without time zone NOT NULL,
    PRIMARY KEY (channel_id, ts)
);

CREATE TABLE IF NOT EXISTS memory_pending_confirmations (
    bot_ts text PRIMARY KEY,
    channel_id text NOT NULL,
    payload jsonb NOT NULL,
    expires_at timestamp without time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS proactive_threads (
    channel_id text NOT NULL,
    thread_ts text NOT NULL,
    titled boolean NOT NULL DEFAULT false,
    inserted_at timestamp without time zone NOT NULL DEFAULT timezone('UTC', now()),
    PRIMARY KEY (channel_id, thread_ts)
);

CREATE OR REPLACE FUNCTION notify_audit_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('audit_events', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_notify ON audit_events;
CREATE TRIGGER audit_events_notify AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION notify_audit_event();
