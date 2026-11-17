ALTER TABLE desk_plans DROP CONSTRAINT IF EXISTS desk_plans_status;
ALTER TABLE desk_plans
    ADD CONSTRAINT desk_plans_status CHECK (status = ANY (ARRAY['heads_up'::text, 'declined'::text, 'requested'::text, 'posting'::text, 'posted'::text])),
    ADD COLUMN IF NOT EXISTS claimed_at timestamp,
    ADD COLUMN IF NOT EXISTS message jsonb;
