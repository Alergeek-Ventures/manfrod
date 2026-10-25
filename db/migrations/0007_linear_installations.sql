CREATE TABLE IF NOT EXISTS linear_installations (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    organization_id text NOT NULL,
    organization_name text,
    app_user_id text,
    access_token bytea NOT NULL,
    refresh_token bytea,
    expires_at timestamp(0) without time zone,
    scope text,
    status text DEFAULT 'connected' NOT NULL,
    installed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS linear_installations_organization_id_index ON linear_installations (organization_id);

DROP TRIGGER IF EXISTS linear_installations_set_updated_at ON linear_installations;
CREATE TRIGGER linear_installations_set_updated_at BEFORE UPDATE ON linear_installations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE project_linear_connections
    ADD COLUMN IF NOT EXISTS installation_id uuid REFERENCES linear_installations(id) ON DELETE SET NULL;
