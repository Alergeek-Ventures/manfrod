defmodule Manfrod.Accounts.User do
  @moduledoc """
  A user identified by their Slack ID.

  Users are auto-provisioned on first Slack interaction — no signup flow.
  The user record is the tenant anchor for all scoped data (memory graph,
  conversations, reminders, audit events).
  """

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "users" do
    field :slack_id, :string
    field :slack_dm_channel_id, :string
    field :name, :string

    timestamps()
  end

  @doc false
  def changeset(user, attrs) do
    user
    |> cast(attrs, [:slack_id, :slack_dm_channel_id, :name])
    |> validate_required([:slack_id, :slack_dm_channel_id])
    |> unique_constraint(:slack_id)
  end
end
