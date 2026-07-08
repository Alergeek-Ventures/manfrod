defmodule Manfrod.Repo.Migrations.CreateProjects do
  use Ecto.Migration

  def change do
    create table(:projects, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :slug, :string, null: false
      add :name, :string, null: false

      timestamps()
    end

    create unique_index(:projects, [:slug])
  end
end
