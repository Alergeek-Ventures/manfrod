defmodule Manfrod.Repo.Migrations.CreateChannelMappings do
  use Ecto.Migration

  def change do
    create table(:channel_mappings, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :slack_channel_id, :string, null: false
      add :slack_channel_name, :string
      # null = company channel (no project)
      add :project_id, references(:projects, type: :binary_id, on_delete: :delete_all)
      # slug used in access arrays: "external/<client_id>", e.g. "10bps"
      # null when channel is company (not client-facing)
      add :client_id, :string
      # "auto_detected" | "admin_confirmed" | "slack_command"
      add :source, :string, null: false
      # "active" | "pending"
      add :status, :string, null: false, default: "active"
      add :set_by_user_id, references(:users, type: :binary_id, on_delete: :nilify_all)

      timestamps()
    end

    create unique_index(:channel_mappings, [:slack_channel_id])
    create index(:channel_mappings, [:project_id])
    create index(:channel_mappings, [:status])
  end
end
