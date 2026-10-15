defmodule Manfrod.Repo.Migrations.AddSoulNodeToUsers do
  use Ecto.Migration

  def up do
    alter table(:users) do
      add :soul_node_id, references(:nodes, type: :binary_id, on_delete: :nilify_all)
    end

    create index(:users, [:soul_node_id])

    execute """
    UPDATE users u
    SET soul_node_id = (
      SELECT n.id FROM nodes n
      WHERE n.user_id = u.id
      ORDER BY n.inserted_at ASC, n.id ASC
      LIMIT 1
    )
    WHERE u.slack_id NOT LIKE 'system:%'
    """
  end

  def down do
    alter table(:users) do
      remove :soul_node_id
    end
  end
end
