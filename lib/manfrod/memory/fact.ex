defmodule Manfrod.Memory.Fact do
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "facts" do
    field :key, :string
    field :value, :string
    field :access, {:array, :string}, default: ["internal"]
    field :valid_from, :utc_datetime
    field :valid_until, :utc_datetime

    belongs_to :set_by_user, User, foreign_key: :set_by_user_id

    timestamps()
  end

  def changeset(fact, attrs) do
    fact
    |> cast(attrs, [:key, :value, :access, :valid_from, :valid_until, :set_by_user_id])
    |> validate_required([:key, :value, :access])
    |> validate_length(:access, min: 1)
  end
end
