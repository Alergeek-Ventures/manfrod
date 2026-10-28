ALTER TABLE agent_secrets ADD COLUMN IF NOT EXISTS scope text DEFAULT 'company' NOT NULL;
ALTER TABLE agent_secrets ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE agent_secrets ADD COLUMN IF NOT EXISTS allowed_hosts text[] DEFAULT ARRAY[]::text[] NOT NULL;

ALTER TABLE agent_secrets DROP CONSTRAINT IF EXISTS agent_secrets_scope;
ALTER TABLE agent_secrets ADD CONSTRAINT agent_secrets_scope CHECK (
    (scope = 'company' AND owner_user_id IS NULL) OR (scope = 'personal' AND owner_user_id IS NOT NULL)
);

DROP INDEX IF EXISTS agent_secrets_name_index;
CREATE UNIQUE INDEX IF NOT EXISTS agent_secrets_company_name_index ON agent_secrets (name) WHERE scope = 'company';
CREATE UNIQUE INDEX IF NOT EXISTS agent_secrets_personal_name_index ON agent_secrets (owner_user_id, name) WHERE scope = 'personal';
