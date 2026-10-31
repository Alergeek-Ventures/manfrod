ALTER TABLE nodes ADD COLUMN IF NOT EXISTS time_checked_at timestamp(0) without time zone;
