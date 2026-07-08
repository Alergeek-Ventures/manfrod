defmodule Manfrod.Repo.Migrations.CreateProjectMemberships do
  use Ecto.Migration

  def change do
    create table(:project_memberships, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false

      add :project_id, references(:projects, type: :binary_id, on_delete: :delete_all),
        null: false

      # "auto_detected" | "admin"
      add :source, :string, null: false, default: "auto_detected"

      timestamps(updated_at: false)
    end

    create unique_index(:project_memberships, [:user_id, :project_id])
    create index(:project_memberships, [:project_id])
  end
end
