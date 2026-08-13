defmodule Manfrod.Repo.Migrations.CreateToolDailyRollups do
  use Ecto.Migration

  def change do
    # Which tools actually get called, at the date x tool grain — coarser than
    # activity_daily_rollups (no user_id) because "which tool is popular" is a
    # fleet-wide question, not a per-person one.
    create table(:tool_daily_rollups, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :date, :date, null: false
      add :tool, :string, null: false

      add :calls, :integer, null: false, default: 0

      timestamps()
    end

    create unique_index(:tool_daily_rollups, [:date, :tool],
             name: :tool_daily_rollups_grain_index
           )

    create index(:tool_daily_rollups, [:date])
    create index(:tool_daily_rollups, [:tool])
  end
end
