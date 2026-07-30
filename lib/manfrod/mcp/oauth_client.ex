defmodule Manfrod.Mcp.OauthClient do
  @moduledoc """
  A dynamically-registered OAuth client for one MCP provider (RFC 7591).

  Registered once per provider on first connect attempt, then reused for
  every user's authorization flow against that provider.
  """

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mcp_oauth_clients" do
    field :provider, :string
    field :client_id, :string
    field :client_secret, :string
    field :authorization_endpoint, :string
    field :token_endpoint, :string
    field :registration_endpoint, :string

    timestamps()
  end

  def changeset(client, attrs) do
    client
    |> cast(attrs, [
      :provider,
      :client_id,
      :client_secret,
      :authorization_endpoint,
      :token_endpoint,
      :registration_endpoint
    ])
    |> validate_required([:provider, :client_id, :authorization_endpoint, :token_endpoint])
    |> unique_constraint(:provider)
  end
end
