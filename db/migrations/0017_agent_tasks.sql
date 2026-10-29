CREATE TABLE IF NOT EXISTS agent_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    goal text NOT NULL,
    success_criteria text NOT NULL,
    plan text,
    channel_id text NOT NULL,
    thread_ts text NOT NULL,
    readable_levels text[] NOT NULL,
    write_access text[] NOT NULL,
    status text DEFAULT 'active' NOT NULL,
    check_every_minutes integer NOT NULL,
    next_check_at timestamp(0) without time zone,
    deadline timestamp(0) without time zone,
    checks integer DEFAULT 0 NOT NULL,
    job_id bigint,
    outcome text,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    closed_at timestamp(0) without time zone,
    CONSTRAINT agent_tasks_status CHECK (status IN ('active', 'blocked', 'done', 'cancelled', 'failed'))
);

CREATE INDEX IF NOT EXISTS agent_tasks_status_index ON agent_tasks (status);
CREATE INDEX IF NOT EXISTS agent_tasks_thread_index ON agent_tasks (channel_id, thread_ts);

CREATE TABLE IF NOT EXISTS agent_task_updates (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    content text NOT NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_task_updates_task_index ON agent_task_updates (task_id, inserted_at);

CREATE TABLE IF NOT EXISTS sent_dms (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
    sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id text NOT NULL,
    message_ts text NOT NULL,
    text text NOT NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS sent_dms_channel_index ON sent_dms (channel_id, inserted_at);
CREATE INDEX IF NOT EXISTS sent_dms_task_index ON sent_dms (task_id);

CREATE TABLE IF NOT EXISTS capability_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    task_id uuid REFERENCES agent_tasks(id) ON DELETE SET NULL,
    requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title text NOT NULL,
    description text NOT NULL,
    reason text NOT NULL,
    channel_id text NOT NULL,
    thread_ts text NOT NULL,
    message_ts text,
    status text DEFAULT 'pending' NOT NULL,
    decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    decided_at timestamp(0) without time zone,
    pull_number integer,
    pull_url text,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    CONSTRAINT capability_requests_status CHECK (status IN ('pending', 'approved', 'rejected', 'merged', 'closed'))
);

CREATE INDEX IF NOT EXISTS capability_requests_status_index ON capability_requests (status);
