ALTER TABLE mcp_custom_providers ADD COLUMN IF NOT EXISTS availability text[] DEFAULT ARRAY['dm', 'internal', 'external']::text[] NOT NULL;
