ALTER TABLE project_memberships ADD COLUMN IF NOT EXISTS removed_at timestamp(0) without time zone;
