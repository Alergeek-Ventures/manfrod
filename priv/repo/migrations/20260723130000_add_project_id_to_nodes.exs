defmodule Manfrod.Repo.Migrations.AddProjectIdToNodes do
  use Ecto.Migration

  def change do
    alter table(:nodes) do
      # Project attribution, stamped at creation from the source channel's
      # mapping. Nullable: pre-existing nodes and nodes from unmapped
      # channels have no project until backfilled manually.
      add :project_id, references(:projects, type: :binary_id, on_delete: :nilify_all)
    end

    create index(:nodes, [:project_id])
  end
end
