ALTER TABLE users ADD COLUMN IF NOT EXISTS role text DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS banned boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_expires timestamp(3) without time zone;
ALTER TABLE session ADD COLUMN IF NOT EXISTS impersonated_by uuid;

UPDATE users SET role = 'admin' WHERE email IN ('franek@alergeek.ventures', 'kamil@alergeek.ventures');
