ALTER TABLE self_review_cases ADD COLUMN memory text;
ALTER TABLE self_review_cases ADD CONSTRAINT self_review_cases_memory CHECK (memory IS NULL OR memory = ANY (ARRAY['helped'::text, 'wrong'::text, 'missing'::text, 'unrelated'::text]));
CREATE INDEX IF NOT EXISTS audit_events_memory_context_index ON audit_events ((meta ->> 'session_key'), "timestamp") WHERE type = 'memory_context';
