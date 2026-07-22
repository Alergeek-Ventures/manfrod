defmodule Manfrod.Desks.Desk do
  @moduledoc """
  A physical desk that can be booked for a specific date.

  `map_x`/`map_y` are pixel coordinates on the static base office-map image
  (see `Manfrod.DeskMap`) — nil means the desk exists and can be booked but
  isn't placed on the rendered map yet. `permanent_owner` marks a desk that's
  always assigned to a fixed person (not necessarily a bot user) and is never
  offered for ad-hoc reservation.
  """
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "desks" do
    field :label, :string
    field :location_note, :string
    field :equipment, {:array, :string}, default: []
    field :map_x, :integer
    field :map_y, :integer
    field :permanent_owner, :string
    field :active, :boolean, default: true

    timestamps()
  end

  def changeset(desk, attrs) do
    desk
    |> cast(attrs, [
      :label,
      :location_note,
      :equipment,
      :map_x,
      :map_y,
      :permanent_owner,
      :active
    ])
    |> validate_required([:label])
    |> update_change(:label, &String.trim/1)
    |> unique_constraint(:label)
  end
end
