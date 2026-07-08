defmodule Manfrod.Repo.Migrations.BackfillExistingNodeAccess do
  use Ecto.Migration

  # All existing nodes and conversations pre-date the access system.
  # Conservative default: "internal" — visible to Manfrod team only, no clients.
  # Faithful to what the system actually guaranteed before this migration.
  # Retroactive reclassification to external/* is a separate curation task.
  def up do
    # Migration 004 already stamped the DEFAULT on all existing rows.
    # This is a safety-net pass to ensure no NULLs slipped through.
    execute "UPDATE nodes SET access = ARRAY['internal'::varchar] WHERE access IS NULL OR array_length(access, 1) IS NULL"

    execute "UPDATE conversations SET access = ARRAY['internal'::varchar] WHERE access IS NULL OR array_length(access, 1) IS NULL"
  end

  def down, do: :ok
end
