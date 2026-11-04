CREATE TABLE IF NOT EXISTS sandbox_files (
    session_id text NOT NULL,
    path text NOT NULL,
    content bytea NOT NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    PRIMARY KEY (session_id, path)
);

CREATE INDEX IF NOT EXISTS sandbox_files_inserted_at_index ON sandbox_files (inserted_at);
