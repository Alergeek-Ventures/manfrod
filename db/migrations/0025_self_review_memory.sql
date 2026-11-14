ALTER TABLE self_review_cases ADD COLUMN memory text;
ALTER TABLE self_review_cases ADD CONSTRAINT self_review_cases_memory CHECK (memory IS NULL OR memory = ANY (ARRAY['helped'::text, 'wrong'::text, 'missing'::text, 'unrelated'::text]));
