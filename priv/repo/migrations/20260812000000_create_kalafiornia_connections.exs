defmodule Manfrod.Repo.Migrations.CreateKalafiorniaConnections do
  use Ecto.Migration

  def change do
    create table(:kalafiornia_connections, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :email, :text, null: false
      add :session, :text, null: false
      add :status, :text, null: false, default: "connected"

      timestamps()
    end

    create unique_index(:kalafiornia_connections, [:user_id])
  end
end
