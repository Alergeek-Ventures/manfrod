defmodule Manfrod.Mcp.CustomProvider do
  @moduledoc """
  A user-added MCP server, identified by URL. `name` and `logo_url` are
  auto-discovered on creation where possible (`Manfrod.Mcp.Discovery`),
  otherwise left for the user to fill in.
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "mcp_custom_providers" do
    field :url, :string
    field :name, :string
    field :logo_url, :string

    belongs_to :user, User

    timestamps()
  end

  def changeset(provider, attrs) do
    provider
    |> cast(attrs, [:user_id, :url, :name, :logo_url])
    |> validate_required([:user_id, :url])
    |> validate_format(:url, ~r/^https?:\/\//, message: "must be a valid http(s) URL")
  end
end
