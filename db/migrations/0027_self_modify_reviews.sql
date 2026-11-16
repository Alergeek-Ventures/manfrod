CREATE TABLE IF NOT EXISTS self_modify_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id text NOT NULL,
    diff_hash text NOT NULL,
    verdict text NOT NULL CONSTRAINT self_modify_reviews_verdict CHECK (verdict = ANY (ARRAY['approve'::text, 'request_changes'::text])),
    findings text NOT NULL DEFAULT '',
    inserted_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now())
);
CREATE INDEX IF NOT EXISTS self_modify_reviews_session_index ON self_modify_reviews (session_id, inserted_at);
