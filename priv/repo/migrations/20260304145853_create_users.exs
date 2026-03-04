defmodule Manfrod.Repo.Migrations.CreateUsers do
  use Ecto.Migration

  def change do
    create table(:users, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :slack_id, :text, null: false
      add :name, :text

      timestamps()
    end

    create unique_index(:users, [:slack_id])
  end
end
