CREATE TABLE IF NOT EXISTS self_modify_merges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pull_number integer NOT NULL,
    head_sha text NOT NULL,
    decision text NOT NULL CONSTRAINT self_modify_merges_decision CHECK (decision = ANY (ARRAY['merging'::text, 'merged'::text, 'retry'::text, 'blocked'::text, 'skipped'::text])),
    reason text,
    targets text[] NOT NULL DEFAULT '{}'::text[],
    attempts integer NOT NULL DEFAULT 0,
    retry_at timestamp,
    merge_sha text,
    channel_id text,
    thread_ts text,
    finding_id uuid,
    target_source text,
    target_title text,
    target_problem text,
    target_expected text,
    verdict text CONSTRAINT self_modify_merges_verdict CHECK (verdict IS NULL OR verdict = ANY (ARRAY['fixed'::text, 'still_broken'::text, 'unclear'::text])),
    merged_at timestamp,
    live_at timestamp,
    inserted_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now())
);
CREATE UNIQUE INDEX IF NOT EXISTS self_modify_merges_head_index ON self_modify_merges (pull_number, head_sha);
CREATE INDEX IF NOT EXISTS self_modify_merges_merged_at_index ON self_modify_merges (merged_at);
ALTER TABLE self_modify_pulls ADD COLUMN IF NOT EXISTS head_sha text;
ALTER TABLE self_modify_pulls ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE self_modify_pulls ADD COLUMN IF NOT EXISTS requested_by_user_id uuid;
ALTER TABLE self_modify_pulls ADD COLUMN IF NOT EXISTS review_verdict text CONSTRAINT self_modify_pulls_review_verdict CHECK (review_verdict IS NULL OR review_verdict = ANY (ARRAY['approve'::text, 'overridden'::text]));
CREATE TABLE IF NOT EXISTS self_modify_rehearsals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    merge_id uuid NOT NULL,
    user_id uuid NOT NULL,
    channel_id text,
    evidence_link text,
    scenario jsonb,
    status text NOT NULL DEFAULT 'pending' CONSTRAINT self_modify_rehearsals_status CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text])),
    session_id text,
    start_attempts integer NOT NULL DEFAULT 0,
    transcript jsonb,
    verdict text CONSTRAINT self_modify_rehearsals_verdict CHECK (verdict IS NULL OR verdict = ANY (ARRAY['fixed'::text, 'still_broken'::text, 'unclear'::text])),
    reason text,
    started_at timestamp,
    finished_at timestamp,
    inserted_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now())
);
CREATE INDEX IF NOT EXISTS self_modify_rehearsals_merge_index ON self_modify_rehearsals (merge_id);
CREATE INDEX IF NOT EXISTS self_modify_rehearsals_status_index ON self_modify_rehearsals (status);
