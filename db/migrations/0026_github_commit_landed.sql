ALTER TABLE github_commits ADD COLUMN IF NOT EXISTS committed_at timestamp;
CREATE INDEX IF NOT EXISTS github_commits_landed_at_index ON github_commits ((coalesce(committed_at, authored_at)));
