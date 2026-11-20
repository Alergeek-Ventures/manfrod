ALTER TABLE desk_plans
    ADD COLUMN IF NOT EXISTS requested_by text;
