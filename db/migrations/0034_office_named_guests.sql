ALTER TABLE office_visits
    ADD COLUMN IF NOT EXISTS guest_names text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE office_visits DROP CONSTRAINT IF EXISTS office_visits_guest_names;
ALTER TABLE office_visits
    ADD CONSTRAINT office_visits_guest_names CHECK (cardinality(guest_names) <= guests);
