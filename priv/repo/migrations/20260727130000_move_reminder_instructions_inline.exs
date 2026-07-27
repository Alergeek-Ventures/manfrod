defmodule Manfrod.Repo.Migrations.MoveReminderInstructionsInline do
  @moduledoc """
  A recurring reminder's instructions were stored as a `nodes` row (the
  zettelkasten) referenced by `node_id`. That put configuration inside the
  knowledge graph, which retrospection rewrites and deduplicates by design:

    * `on_delete: :restrict` + the bare `Repo.delete/1` in
      `Retrospector.absorb/3` meant merging away an instruction note raised
      an unrescued restrict_violation, failing the whole retrospection job.
    * The retrospector prefers `update_node` when consolidating duplicates,
      so an instruction note surviving a merge got its content rewritten by
      the LLM — the cron silently changed behaviour with no error.

  Instructions now live in a plain `instructions` column. The table was
  empty in every environment when this ran, so there is no data to backfill.
  """
  use Ecto.Migration

  def up do
    alter table(:recurring_reminders) do
      add :instructions, :text
    end

    # Empty in all environments at migration time; the default satisfies the
    # NOT NULL for any row that somehow predates this.
    execute "UPDATE recurring_reminders SET instructions = '' WHERE instructions IS NULL"

    alter table(:recurring_reminders) do
      modify :instructions, :text, null: false
    end

    drop index(:recurring_reminders, [:node_id])

    alter table(:recurring_reminders) do
      remove :node_id
    end
  end

  def down do
    alter table(:recurring_reminders) do
      add :node_id, references(:nodes, type: :binary_id, on_delete: :restrict)
      remove :instructions
    end

    create index(:recurring_reminders, [:node_id])
  end
end
