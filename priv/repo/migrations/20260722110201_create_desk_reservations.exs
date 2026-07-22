defmodule Manfrod.Repo.Migrations.CreateDeskReservations do
  use Ecto.Migration

  def change do
    create table(:desk_reservations, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :desk_id, references(:desks, type: :binary_id, on_delete: :delete_all), null: false
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :date, :date, null: false
      add :note, :string

      timestamps()
    end

    create unique_index(:desk_reservations, [:desk_id, :date])
    create index(:desk_reservations, [:user_id, :date])
  end
end
