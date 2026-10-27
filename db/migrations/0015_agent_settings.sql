CREATE TABLE IF NOT EXISTS agent_settings (
    key text NOT NULL PRIMARY KEY,
    value text NOT NULL,
    updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);

ALTER TABLE self_review_findings ADD COLUMN IF NOT EXISTS summary text;
