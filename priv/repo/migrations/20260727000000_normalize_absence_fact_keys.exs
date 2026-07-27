defmodule Manfrod.Repo.Migrations.NormalizeAbsenceFactKeys do
  use Ecto.Migration

  @moduledoc """
  "absence:" is (and was) the canonical fact-key prefix for vacations — it's
  what the vacation-tracking skill instructs the agent to query
  (priv/skills/vacation-tracking/SKILL.md). The classifier used to compose
  the key as "absence:<display_name>:<date>"; it now uses the linked user's
  id when known ("absence:<user_id>:<date>"), matching the format
  Tools.Vacation's direct-write fallback already used, so both writers land
  on the same identifier shape. Normalizes existing rows to match.
  """

  def up do
    execute(~S"""
    UPDATE facts
    SET key = 'absence:' || set_by_user_id::text || ':' || (regexp_match(key, '(\d{4}-\d{2}-\d{2})$'))[1]
    WHERE key LIKE 'absence:%' AND set_by_user_id IS NOT NULL
    """)
  end

  def down do
    execute(~S"""
    UPDATE facts f
    SET key = 'absence:' || u.name || ':' || (regexp_match(f.key, '(\d{4}-\d{2}-\d{2})$'))[1]
    FROM users u
    WHERE f.set_by_user_id = u.id AND f.key LIKE 'absence:%'
    """)
  end
end
