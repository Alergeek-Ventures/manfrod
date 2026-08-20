defmodule Manfrod.Mcp.Connection do
  @moduledoc """
  A user's OAuth connection to a remote MCP server (Granola, Firmowid, ...).

  `status` is one of `"connected"`, `"expired"`, `"disconnected"`. Tokens
  are stored in plaintext, matching the precedent set by
  `Manfrod.Accounts.GoogleIdentity`.
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mcp_connections" do
    field :provider, :string
    field :status, :string, default: "connected"
    field :access_token, :string
    field :refresh_token, :string
    field :expires_at, :utc_datetime
    field :scope, :string
    field :notified_expired_at, :utc_datetime

    belongs_to :user, User

    timestamps()
  end

  def changeset(connection, attrs) do
    connection
    |> cast(attrs, [
      :user_id,
      :provider,
      :status,
      :access_token,
      :refresh_token,
      :expires_at,
      :scope,
      :notified_expired_at
    ])
    |> validate_required([:user_id, :provider, :status])
    |> validate_inclusion(:status, ["connected", "expired", "disconnected"])
    |> unique_constraint([:user_id, :provider])
  end
end
