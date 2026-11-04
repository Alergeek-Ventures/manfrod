ALTER TABLE mcp_connections ADD COLUMN IF NOT EXISTS access_token_encrypted bytea;
ALTER TABLE mcp_connections ADD COLUMN IF NOT EXISTS refresh_token_encrypted bytea;
