defmodule Manfrod.Repo.Migrations.CreateMcpTables do
  use Ecto.Migration

  def change do
    # One row per (provider, app) — dynamic client registration is done once
    # per provider and reused across every user's authorization flow.
    create table(:mcp_oauth_clients, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :provider, :text, null: false
      add :client_id, :text, null: false
      add :client_secret, :text
      add :authorization_endpoint, :text, null: false
      add :token_endpoint, :text, null: false
      add :registration_endpoint, :text

      timestamps()
    end

    create unique_index(:mcp_oauth_clients, [:provider])

    create table(:mcp_connections, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :provider, :text, null: false
      add :status, :text, null: false, default: "connected"
      add :access_token, :text
      add :refresh_token, :text
      add :expires_at, :utc_datetime
      add :scope, :text
      add :notified_expired_at, :utc_datetime

      timestamps()
    end

    create unique_index(:mcp_connections, [:user_id, :provider])
  end
end
