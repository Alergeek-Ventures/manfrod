CREATE TABLE IF NOT EXISTS self_modify_lessons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pull_number integer NOT NULL,
    lesson text NOT NULL,
    inserted_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now())
);
CREATE INDEX IF NOT EXISTS self_modify_lessons_inserted_at_index ON self_modify_lessons (inserted_at);
ALTER TABLE self_modify_pulls ADD COLUMN IF NOT EXISTS learned_at timestamp;
ALTER TABLE self_modify_pulls ADD COLUMN IF NOT EXISTS learn_attempts integer NOT NULL DEFAULT 0;
