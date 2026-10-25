ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean DEFAULT false NOT NULL;

UPDATE users SET is_admin = true WHERE email IN ('franek@alergeek.ventures', 'kamil@alergeek.ventures');
