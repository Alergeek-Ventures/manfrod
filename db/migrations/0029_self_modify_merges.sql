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
    task_id uuid,
    verdict text CONSTRAINT self_modify_merges_verdict CHECK (verdict IS NULL OR verdict = ANY (ARRAY['better'::text, 'no_change'::text, 'worse'::text, 'not_enough_data'::text])),
    merged_at timestamp,
    live_at timestamp,
    inserted_at timestamp NOT NULL DEFAULT timezone('UTC'::text, now())
);
CREATE UNIQUE INDEX IF NOT EXISTS self_modify_merges_head_index ON self_modify_merges (pull_number, head_sha);
CREATE INDEX IF NOT EXISTS self_modify_merges_merged_at_index ON self_modify_merges (merged_at);
ALTER TABLE self_modify_pulls ADD COLUMN IF NOT EXISTS head_sha text;
ALTER TABLE self_modify_pulls ADD COLUMN IF NOT EXISTS review_verdict text CONSTRAINT self_modify_pulls_review_verdict CHECK (review_verdict IS NULL OR review_verdict = ANY (ARRAY['approve'::text, 'overridden'::text]));
