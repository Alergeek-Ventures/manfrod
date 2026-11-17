UPDATE desks
SET owner_user_id = matched.user_id,
    location_note = NULLIF(btrim(regexp_replace(coalesce(location_note, ''), '(;\s*)?zwykle:\s*Staszek', '', 'i'), '; '), ''),
    updated_at = timezone('UTC'::text, now())
FROM (
    SELECT min(u.id::text)::uuid AS user_id
    FROM users u
    WHERE (lower(u.name) = 'staszek' OR lower(split_part(u.name, ' ', 1)) IN ('staszek', 'stanisław', 'stanislaw'))
      AND u.slack_id NOT LIKE 'system:%' AND u.banned IS NOT TRUE
    HAVING count(*) = 1
) matched
WHERE desks.label = 'B3' AND desks.owner_user_id IS NULL;
