defmodule Manfrod.Repo.Migrations.CreateProjectLinearConnections do
  use Ecto.Migration

  def change do
    create table(:project_linear_connections, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :project_id, references(:projects, type: :binary_id, on_delete: :delete_all),
        null: false

      add :api_key, :binary
      add :status, :text, null: false, default: "connected"
      add :linear_team_id, :text
      add :linear_team_name, :text
      add :connected_by_user_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :disconnected_at, :utc_datetime

      timestamps()
    end

    create unique_index(:project_linear_connections, [:project_id])
  end
end
