defmodule Manfrod.Repo.Migrations.CreateDesks do
  use Ecto.Migration

  def change do
    create table(:desks, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :label, :string, null: false
      add :location_note, :string
      add :equipment, {:array, :string}, null: false, default: []
      add :map_x, :integer
      add :map_y, :integer
      add :permanent_owner, :string
      add :active, :boolean, null: false, default: true

      timestamps()
    end

    create unique_index(:desks, [:label])
    create index(:desks, [:active])
  end
end
