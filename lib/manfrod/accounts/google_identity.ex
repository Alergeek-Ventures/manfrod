defmodule Manfrod.Accounts.GoogleIdentity do
  @moduledoc """
  Google OAuth identity linked to a user.

  Stores the stable Google `sub` (subject) identifier and OAuth tokens.
  One-to-one relationship with `User` — a user can have at most one
  Google identity.

  The `google_sub` is the primary lookup key (stable across email changes).
  Tokens are stored for future Google API access (e.g. Calendar).
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "google_identities" do
    field :google_sub, :string
    field :access_token, :string
    field :refresh_token, :string
    field :token_expires_at, :integer

    belongs_to :user, User

    timestamps()
  end

  @doc """
  Changeset for creating a new Google identity.
  """
  def changeset(identity, attrs) do
    identity
    |> cast(attrs, [:google_sub, :access_token, :refresh_token, :token_expires_at])
    |> validate_required([:google_sub])
    |> unique_constraint(:user_id)
    |> unique_constraint(:google_sub)
  end
end
