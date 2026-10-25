ALTER TABLE memory_buffer ADD COLUMN IF NOT EXISTS claimed_at timestamp without time zone;
ALTER TABLE memory_buffer ADD COLUMN IF NOT EXISTS attempts integer DEFAULT 0 NOT NULL;
