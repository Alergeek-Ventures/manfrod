defmodule Manfrod.Repo.Migrations.AddAccessToNodes do
  use Ecto.Migration

  def up do
    alter table(:nodes) do
      add :access, {:array, :string}, null: false, default: ["internal"]
    end

    # GIN index for array overlap queries: WHERE access && ARRAY[...]
    execute "CREATE INDEX nodes_access_gin_idx ON nodes USING gin(access)"

    # Rebuild BM25 index to include access for filtered full-text search
    execute "DROP INDEX IF EXISTS nodes_bm25_idx"

    execute """
    CREATE INDEX nodes_bm25_idx ON nodes
    USING bm25 (id, content, user_id, access)
    WITH (key_field='id')
    """
  end

  def down do
    execute "DROP INDEX IF EXISTS nodes_bm25_idx"

    execute """
    CREATE INDEX nodes_bm25_idx ON nodes
    USING bm25 (id, content, user_id)
    WITH (key_field='id')
    """

    execute "DROP INDEX IF EXISTS nodes_access_gin_idx"

    alter table(:nodes) do
      remove :access
    end
  end
end
