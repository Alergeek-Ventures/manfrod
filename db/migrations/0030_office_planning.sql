CREATE TABLE IF NOT EXISTS office_layouts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    width integer NOT NULL DEFAULT 60 CONSTRAINT office_layouts_width CHECK (width BETWEEN 10 AND 400),
    height integer NOT NULL DEFAULT 40 CONSTRAINT office_layouts_height CHECK (height BETWEEN 10 AND 400),
    elements jsonb NOT NULL DEFAULT '[]'::jsonb,
    plan_channel_id text,
    crowded_threshold integer NOT NULL DEFAULT 6 CONSTRAINT office_layouts_crowded_threshold CHECK (crowded_threshold > 0),
    updated_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now())
);

INSERT INTO office_layouts (name)
SELECT 'Biuro' WHERE NOT EXISTS (SELECT 1 FROM office_layouts);

ALTER TABLE desks
    ADD COLUMN IF NOT EXISTS layout_id uuid REFERENCES office_layouts(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS x integer,
    ADD COLUMN IF NOT EXISTS y integer,
    ADD COLUMN IF NOT EXISTS width integer NOT NULL DEFAULT 6,
    ADD COLUMN IF NOT EXISTS height integer NOT NULL DEFAULT 4,
    ADD COLUMN IF NOT EXISTS rotation integer NOT NULL DEFAULT 0 CONSTRAINT desks_rotation CHECK (rotation = ANY (ARRAY[0, 90, 180, 270])),
    ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

UPDATE desks SET layout_id = (SELECT id FROM office_layouts ORDER BY updated_at LIMIT 1) WHERE layout_id IS NULL;
ALTER TABLE desks ALTER COLUMN layout_id SET NOT NULL;

UPDATE desks
SET owner_user_id = matched.user_id
FROM (
    SELECT d.id AS desk_id, min(u.id::text)::uuid AS user_id
    FROM desks d
    JOIN users u ON (lower(u.name) = lower(d.permanent_owner) OR lower(split_part(u.name, ' ', 1)) = lower(d.permanent_owner))
        AND u.slack_id NOT LIKE 'system:%'
        AND u.banned IS NOT TRUE
    WHERE d.permanent_owner IS NOT NULL
    GROUP BY d.id
    HAVING count(*) = 1
) matched
WHERE desks.id = matched.desk_id;

UPDATE desks
SET location_note = coalesce(location_note || '; ', '') || 'na stałe: ' || permanent_owner
WHERE permanent_owner IS NOT NULL AND owner_user_id IS NULL;

ALTER TABLE desks DROP COLUMN IF EXISTS map_x, DROP COLUMN IF EXISTS map_y, DROP COLUMN IF EXISTS permanent_owner;
CREATE INDEX IF NOT EXISTS desks_owner_user_id_index ON desks (owner_user_id);

ALTER TABLE desk_reservations
    ALTER COLUMN user_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS guest_name text,
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual' CONSTRAINT desk_reservations_source CHECK (source = ANY (ARRAY['manual'::text, 'plan'::text])),
    ADD CONSTRAINT desk_reservations_person CHECK (user_id IS NOT NULL OR guest_name IS NOT NULL);

CREATE TABLE IF NOT EXISTS office_members (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    layout_id uuid NOT NULL REFERENCES office_layouts(id) ON DELETE CASCADE,
    inserted_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now())
);

INSERT INTO office_members (user_id, layout_id)
SELECT DISTINCT person.user_id, (SELECT id FROM office_layouts ORDER BY updated_at LIMIT 1)
FROM (
    SELECT owner_user_id AS user_id FROM desks WHERE owner_user_id IS NOT NULL
    UNION
    SELECT user_id FROM desk_reservations WHERE user_id IS NOT NULL AND date >= current_date - 180
) person
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS office_presence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date date NOT NULL,
    status text NOT NULL CONSTRAINT office_presence_status CHECK (status = ANY (ARRAY['office'::text, 'remote'::text, 'leave'::text])),
    source text NOT NULL CONSTRAINT office_presence_source CHECK (source = ANY (ARRAY['chat'::text, 'button'::text])),
    note text,
    updated_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now()),
    CONSTRAINT office_presence_user_date UNIQUE (user_id, date)
);
CREATE INDEX IF NOT EXISTS office_presence_date_index ON office_presence (date);

CREATE TABLE IF NOT EXISTS office_visits (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    layout_id uuid NOT NULL REFERENCES office_layouts(id) ON DELETE CASCADE,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    user_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
    guests integer NOT NULL DEFAULT 0 CONSTRAINT office_visits_guests CHECK (guests >= 0),
    note text NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at timestamp,
    inserted_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now()),
    CONSTRAINT office_visits_range CHECK (ends_on >= starts_on),
    CONSTRAINT office_visits_people CHECK (guests > 0 OR cardinality(user_ids) > 0)
);
CREATE INDEX IF NOT EXISTS office_visits_dates_index ON office_visits (starts_on, ends_on);

CREATE TABLE IF NOT EXISTS desk_plans (
    layout_id uuid NOT NULL REFERENCES office_layouts(id) ON DELETE CASCADE,
    date date NOT NULL,
    status text NOT NULL CONSTRAINT desk_plans_status CHECK (status = ANY (ARRAY['heads_up'::text, 'declined'::text, 'posted'::text])),
    reason text,
    channel_id text,
    message_ts text,
    heads_up_ts text,
    version integer NOT NULL DEFAULT 1,
    updated_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now()),
    PRIMARY KEY (layout_id, date)
);
