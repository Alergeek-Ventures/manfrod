defmodule Manfrod.Repo.Migrations.AddUserIdToTables do
  use Ecto.Migration

  def up do
    # Add user_id to all tenant-scoped tables
    for table <- ~w(nodes messages conversations recurring_reminders audit_events) do
      alter table(table) do
        add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      end

      create index(table, [:user_id])
    end

    # Recreate BM25 index with user_id for filtered search
    execute "DROP INDEX IF EXISTS nodes_bm25_idx"

    execute """
    CREATE INDEX nodes_bm25_idx ON nodes
    USING bm25 (id, content, user_id)
    WITH (key_field='id')
    """

    # Update partial indexes to include user_id for efficient scoped lookups

    # Messages: pending messages per user
    execute "DROP INDEX IF EXISTS messages_pending_received_at_index"

    create index(:messages, [:user_id, :received_at],
             where: "conversation_id IS NULL",
             name: "messages_pending_user_received_at_index"
           )

    # Nodes: slipbox nodes per user
    execute "DROP INDEX IF EXISTS nodes_slipbox_inserted_at_index"

    create index(:nodes, [:user_id, :inserted_at],
             where: "processed_at IS NULL",
             name: "nodes_slipbox_user_inserted_at_index"
           )
  end

  def down do
    # Restore original partial indexes
    execute "DROP INDEX IF EXISTS messages_pending_user_received_at_index"

    create index(:messages, [:received_at],
             where: "conversation_id IS NULL",
             name: "messages_pending_received_at_index"
           )

    execute "DROP INDEX IF EXISTS nodes_slipbox_user_inserted_at_index"

    create index(:nodes, [:inserted_at],
             where: "processed_at IS NULL",
             name: "nodes_slipbox_inserted_at_index"
           )

    # Restore BM25 without user_id
    execute "DROP INDEX IF EXISTS nodes_bm25_idx"

    execute """
    CREATE INDEX nodes_bm25_idx ON nodes
    USING bm25 (id, content)
    WITH (key_field='id')
    """

    for table <- ~w(audit_events recurring_reminders conversations messages nodes) do
      drop index(table, [:user_id])

      alter table(table) do
        remove :user_id
      end
    end
  end
end
