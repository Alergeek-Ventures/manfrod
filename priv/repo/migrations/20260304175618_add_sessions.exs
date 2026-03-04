defmodule Manfrod.Repo.Migrations.AddSessions do
  use Ecto.Migration

  def up do
    # Add session_key to messages and conversations
    alter table(:messages) do
      add :session_key, :text, null: false
    end

    alter table(:conversations) do
      add :session_key, :text, null: false
    end

    # Add slack_dm_channel_id to users (NOT NULL — first interaction must be DM)
    alter table(:users) do
      add :slack_dm_channel_id, :text, null: false
    end

    # Update pending messages partial index to include session_key
    execute "DROP INDEX IF EXISTS messages_pending_user_received_at_index"

    create index(:messages, [:user_id, :session_key, :received_at],
             where: "conversation_id IS NULL",
             name: "messages_pending_user_session_index"
           )

    # Index for looking up conversations by session
    create index(:conversations, [:user_id, :session_key])
  end

  def down do
    execute "DROP INDEX IF EXISTS messages_pending_user_session_index"

    create index(:messages, [:user_id, :received_at],
             where: "conversation_id IS NULL",
             name: "messages_pending_user_received_at_index"
           )

    drop index(:conversations, [:user_id, :session_key])

    alter table(:users) do
      remove :slack_dm_channel_id
    end

    alter table(:conversations) do
      remove :session_key
    end

    alter table(:messages) do
      remove :session_key
    end
  end
end
