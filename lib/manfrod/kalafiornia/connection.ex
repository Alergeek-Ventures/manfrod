defmodule Manfrod.Kalafiornia.Connection do
  @moduledoc """
  A user's session with the Kalafiornia office-door app (kalafiornia.pl).

  Kalafiornia has no OAuth — login is email + emailed PIN, which exchanges
  for a plain session cookie (`Manfrod.Kalafiornia.Client`). `status` is
  `"connected"` or `"invalid"` (set once `open-door` reports the session as
  logged out, so the tool can tell the user to log in again).
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "kalafiornia_connections" do
    field :email, :string
    field :session, :string
    field :status, :string, default: "connected"

    belongs_to :user, User

    timestamps()
  end

  def changeset(connection, attrs) do
    connection
    |> cast(attrs, [:user_id, :email, :session, :status])
    |> validate_required([:user_id, :email, :session, :status])
    |> validate_inclusion(:status, ["connected", "invalid"])
    |> unique_constraint(:user_id)
  end
end
