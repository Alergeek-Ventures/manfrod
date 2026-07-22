defmodule Manfrod.Desks.DeskReservation do
  @moduledoc """
  A single-day booking of a desk by a user. One desk can have at most one
  reservation per date (enforced by a unique index on `[:desk_id, :date]`).
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Desks.Desk

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "desk_reservations" do
    field :date, :date
    field :note, :string

    belongs_to :desk, Desk
    belongs_to :user, User

    timestamps()
  end

  def changeset(reservation, attrs) do
    reservation
    |> cast(attrs, [:desk_id, :user_id, :date, :note])
    |> validate_required([:desk_id, :user_id, :date])
    |> unique_constraint([:desk_id, :date])
    |> foreign_key_constraint(:desk_id)
    |> foreign_key_constraint(:user_id)
  end
end
