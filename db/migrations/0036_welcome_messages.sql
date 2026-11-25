CREATE TABLE IF NOT EXISTS welcome_messages (
    slack_id text NOT NULL PRIMARY KEY,
    status text NOT NULL,
    reason text,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    channel_id text,
    message_ts text,
    scheduled_for timestamp(0) without time zone,
    sent_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    CONSTRAINT welcome_messages_status CHECK (status IN ('scheduled', 'sent', 'skipped'))
);
