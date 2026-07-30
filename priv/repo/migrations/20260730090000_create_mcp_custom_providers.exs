defmodule Manfrod.Repo.Migrations.CreateMcpCustomProviders do
  use Ecto.Migration

  def change do
    create table(:mcp_custom_providers, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :url, :text, null: false
      add :name, :text
      add :logo_url, :text

      timestamps()
    end

    create index(:mcp_custom_providers, [:user_id])
  end
end
