defmodule Manfrod.Repo.Migrations.CreateFacts do
  use Ecto.Migration

  def change do
    create table(:facts, primary_key: false) do
      add :id, :binary_id, primary_key: true
      # namespaced key, e.g. "vacation:user-uuid" or "meeting:project-uuid:2026-07-05"
      add :key, :string, null: false
      add :value, :text, null: false
      add :access, {:array, :string}, null: false, default: ["internal"]
      add :set_by_user_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :valid_from, :utc_datetime
      add :valid_until, :utc_datetime

      timestamps()
    end

    create index(:facts, [:key])
    create index(:facts, :access, using: :gin)
    create index(:facts, [:valid_from, :valid_until])
  end
end
