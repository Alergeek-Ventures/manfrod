CREATE TABLE IF NOT EXISTS self_modify_pulls (
    pull_number integer NOT NULL PRIMARY KEY,
    branch text NOT NULL,
    session_id text NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    closed_at timestamp(0) without time zone,
    CONSTRAINT self_modify_pulls_status CHECK (status IN ('open', 'closed'))
);

CREATE INDEX IF NOT EXISTS self_modify_pulls_status_index ON self_modify_pulls (status);
