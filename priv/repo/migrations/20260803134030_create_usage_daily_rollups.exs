defmodule Manfrod.Repo.Migrations.CreateUsageDailyRollups do
  use Ecto.Migration

  def change do
    # Raw audit_events are purged after 7 days (Events.Persister), which would
    # reset every adoption trend weekly. This table holds the pre-aggregated
    # usage grain we want to keep indefinitely: one row per
    # day x user x model x purpose.
    create table(:usage_daily_rollups, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :date, :date, null: false
      # Nullable: system work (classifier, cron skills) has no owning user.
      add :user_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :model, :string, null: false
      add :purpose, :string, null: false
      add :provider, :string
      add :tier, :string

      add :calls, :integer, null: false, default: 0
      add :failed_calls, :integer, null: false, default: 0
      add :retries, :integer, null: false, default: 0
      add :fallbacks, :integer, null: false, default: 0

      add :input_tokens, :bigint, null: false, default: 0
      add :output_tokens, :bigint, null: false, default: 0
      add :cached_tokens, :bigint, null: false, default: 0
      add :cache_creation_tokens, :bigint, null: false, default: 0

      # Priced at the rate in effect when the rollup ran, so a later price
      # change never retroactively rewrites historical spend.
      add :cost_usd, :decimal, precision: 14, scale: 8, null: false, default: 0
      add :uncached_cost_usd, :decimal, precision: 14, scale: 8, null: false, default: 0

      add :total_latency_ms, :bigint, null: false, default: 0

      timestamps()
    end

    # Upsert target: recomputing a day must replace its rows, not duplicate
    # them. NULLS NOT DISTINCT so system-work rows (user_id IS NULL) collide on
    # conflict too, instead of inserting a fresh row on every run.
    create unique_index(
             :usage_daily_rollups,
             [:date, :user_id, :model, :purpose],
             name: :usage_daily_rollups_grain_index,
             nulls_distinct: false
           )

    create index(:usage_daily_rollups, [:date])
    create index(:usage_daily_rollups, [:user_id])
    create index(:usage_daily_rollups, [:model])

    # Adoption metrics live at a coarser grain than LLM usage: a user who used
    # two models in one day sent one set of messages, not one per model. Keeping
    # them in the usage table would multiply every activity count by the number
    # of model/purpose combinations that day.
    create table(:activity_daily_rollups, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :date, :date, null: false
      add :user_id, references(:users, type: :binary_id, on_delete: :nilify_all)

      add :messages_received, :integer, null: false, default: 0
      add :messages_sent, :integer, null: false, default: 0
      add :tool_calls, :integer, null: false, default: 0
      add :sessions, :integer, null: false, default: 0
      add :memory_searches, :integer, null: false, default: 0
      add :notes_created, :integer, null: false, default: 0

      timestamps()
    end

    create unique_index(:activity_daily_rollups, [:date, :user_id],
             name: :activity_daily_rollups_grain_index,
             nulls_distinct: false
           )

    create index(:activity_daily_rollups, [:date])
    create index(:activity_daily_rollups, [:user_id])
  end
end
