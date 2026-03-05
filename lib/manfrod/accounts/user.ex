defmodule Manfrod.Accounts.User do
  @moduledoc """
  A user identified by their Slack ID.

  Users are auto-provisioned from Slack on first DM interaction.
  The `slack_id` and `slack_dm_channel_id` are always required (NOT NULL).

  A user may optionally have:
  - `email` — backfilled from Slack (`users:read.email` scope) or set
    during Google Sign-In linking.
  - A linked `GoogleIdentity` — created when the user signs in with Google.

  The user record is the tenant anchor for all scoped data (memory graph,
  conversations, reminders, audit events).
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.GoogleIdentity

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "users" do
    field :slack_id, :string
    field :slack_dm_channel_id, :string
    field :name, :string
    field :email, :string

    has_one :google_identity, GoogleIdentity

    timestamps()
  end

  @doc false
  def changeset(user, attrs) do
    user
    |> cast(attrs, [:slack_id, :slack_dm_channel_id, :name, :email])
    |> validate_required([:slack_id, :slack_dm_channel_id])
    |> unique_constraint(:slack_id)
    |> unique_constraint(:email)
  end
end
