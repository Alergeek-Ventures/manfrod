defmodule Manfrod.Repo.Migrations.AddAccessToConversations do
  use Ecto.Migration

  def change do
    alter table(:conversations) do
      add :access, {:array, :string}, null: false, default: ["internal"]
      # denormalized for extractor — avoids re-querying channel_mappings
      add :slack_channel_id, :string
    end

    create index(:conversations, [:slack_channel_id])
  end
end
