ALTER TABLE mcp_custom_providers ADD COLUMN IF NOT EXISTS auth_header text;
ALTER TABLE mcp_connections ADD COLUMN IF NOT EXISTS header_value bytea;
