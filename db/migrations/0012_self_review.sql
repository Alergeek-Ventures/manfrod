CREATE TABLE IF NOT EXISTS self_review_findings (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    title text NOT NULL,
    problem text NOT NULL,
    expected text NOT NULL,
    category text NOT NULL,
    severity integer DEFAULT 2 NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    pull_number integer,
    pull_url text,
    session_channel_id text,
    session_thread_ts text,
    started_at timestamp(0) without time zone,
    resolved_at timestamp(0) without time zone,
    notified_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    CONSTRAINT self_review_findings_status CHECK (status IN ('open', 'in_progress', 'proposed', 'merged', 'closed', 'unresolved', 'dismissed')),
    CONSTRAINT self_review_findings_category CHECK (category IN ('prompt', 'skill', 'routine', 'tool')),
    CONSTRAINT self_review_findings_severity CHECK (severity BETWEEN 1 AND 3)
);

CREATE INDEX IF NOT EXISTS self_review_findings_status_index ON self_review_findings (status);

DROP TRIGGER IF EXISTS self_review_findings_set_updated_at ON self_review_findings;
CREATE TRIGGER self_review_findings_set_updated_at BEFORE UPDATE ON self_review_findings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS self_review_cases (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    feedback_id uuid NOT NULL REFERENCES message_feedback(id) ON DELETE CASCADE,
    finding_id uuid REFERENCES self_review_findings(id) ON DELETE SET NULL,
    status text NOT NULL,
    reason text,
    question text,
    clarification_channel_id text,
    clarification_thread_ts text,
    asked_at timestamp(0) without time zone,
    inserted_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    updated_at timestamp(0) without time zone DEFAULT timezone('UTC', now()) NOT NULL,
    CONSTRAINT self_review_cases_status CHECK (status IN ('linked', 'not_actionable', 'needs_input', 'asked', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS self_review_cases_feedback_index ON self_review_cases (feedback_id);
CREATE INDEX IF NOT EXISTS self_review_cases_finding_index ON self_review_cases (finding_id);
CREATE INDEX IF NOT EXISTS self_review_cases_status_index ON self_review_cases (status);

DROP TRIGGER IF EXISTS self_review_cases_set_updated_at ON self_review_cases;
CREATE TRIGGER self_review_cases_set_updated_at BEFORE UPDATE ON self_review_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
