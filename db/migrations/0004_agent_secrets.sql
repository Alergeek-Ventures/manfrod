CREATE TABLE IF NOT EXISTS agent_secrets (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    name text NOT NULL,
    value bytea NOT NULL,
    description text,
    updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    CONSTRAINT agent_secrets_name_format CHECK (name ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_secrets_name_index ON agent_secrets (name);

DROP TRIGGER IF EXISTS agent_secrets_set_updated_at ON agent_secrets;
CREATE TRIGGER agent_secrets_set_updated_at BEFORE UPDATE ON agent_secrets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
