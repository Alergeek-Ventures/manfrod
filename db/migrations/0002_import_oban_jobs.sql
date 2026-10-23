DO $$
BEGIN
  IF to_regclass('public.oban_jobs') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO jobs (id, kind, args, meta, state, scheduled_at, unique_key, attempt, max_attempts, inserted_at)
  SELECT
    o.id,
    CASE o.worker
      WHEN 'Manfrod.Workers.TriggerWorker' THEN 'trigger'
      WHEN 'Manfrod.Workers.FirmowidSessionCheckWorker' THEN 'firmowid_session_check'
      WHEN 'Manfrod.Workers.FirmowidMorningSessionCheckWorker' THEN 'firmowid_morning_session_check'
    END,
    o.args,
    COALESCE(o.meta, '{}'::jsonb),
    'scheduled',
    o.scheduled_at,
    CASE
      WHEN o.worker = 'Manfrod.Workers.TriggerWorker' AND o.args ? 'recurring_reminder_id'
        THEN 'trigger:' || (o.args->>'recurring_reminder_id') || ':' || (o.args->>'scheduled_at')
      WHEN o.worker = 'Manfrod.Workers.FirmowidSessionCheckWorker'
        THEN 'firmowid_session_check:' || (o.args->>'user_id') || ':' || (o.args->>'date')
      WHEN o.worker = 'Manfrod.Workers.FirmowidMorningSessionCheckWorker'
        THEN 'firmowid_morning_session_check:' || (o.args->>'user_id') || ':' || (o.args->>'date')
    END,
    0,
    3,
    o.inserted_at
  FROM oban_jobs o
  WHERE o.state IN ('available', 'scheduled', 'retryable')
    AND o.worker IN (
      'Manfrod.Workers.TriggerWorker',
      'Manfrod.Workers.FirmowidSessionCheckWorker',
      'Manfrod.Workers.FirmowidMorningSessionCheckWorker'
    )
  ON CONFLICT DO NOTHING;

  PERFORM setval(pg_get_serial_sequence('jobs', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM jobs), (SELECT COALESCE(MAX(id), 0) FROM oban_jobs)) + 1, false);
END
$$;
