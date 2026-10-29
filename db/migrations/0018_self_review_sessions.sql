CREATE TABLE IF NOT EXISTS self_review_sessions (
    session_key text NOT NULL PRIMARY KEY,
    judged_until timestamp(0) without time zone NOT NULL,
    verdict text NOT NULL,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    CONSTRAINT self_review_sessions_verdict CHECK (verdict IN ('satisfied', 'unsatisfied', 'unclear', 'skipped'))
);
