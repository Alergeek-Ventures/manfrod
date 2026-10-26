CREATE TABLE IF NOT EXISTS nudge_preferences (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    enabled boolean NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS nudge_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    period text NOT NULL,
    sent boolean NOT NULL,
    reason text,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS nudge_deliveries_period_index ON nudge_deliveries (user_id, kind, period);

CREATE TABLE IF NOT EXISTS channel_nudges (
    channel_id text NOT NULL PRIMARY KEY,
    summaries boolean DEFAULT true NOT NULL,
    last_summary_period text,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);
