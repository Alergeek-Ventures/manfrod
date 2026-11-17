ALTER TABLE desk_plans
    ADD COLUMN IF NOT EXISTS away_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
    ADD COLUMN IF NOT EXISTS seating text;
