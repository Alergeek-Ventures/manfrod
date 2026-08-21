defmodule Manfrod.Linear.Connection do
  @moduledoc """
  A project's Linear integration: a read-only, team-scoped Personal API Key
  pasted by whoever ran `/linear-status` in a channel mapped to that project.

  Unlike every other credential in this codebase (`Manfrod.Mcp.Connection`,
  `Manfrod.Accounts.GoogleIdentity`, `Manfrod.Kalafiornia.Connection`, all
  plaintext by explicit precedent), `api_key` is encrypted at rest via
  `Manfrod.Encrypted.Binary` / `Manfrod.Vault` — a deliberate, explicit
  product decision for this one field, not a repo-wide policy change.

  `status` is `"connected"` or `"disconnected"`. Disconnecting flips the
  status rather than deleting the row, so the admin panel keeps a history of
  who connected what.
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Memory.Project

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @type t :: %__MODULE__{}

  schema "project_linear_connections" do
    field :api_key, Manfrod.Encrypted.Binary
    field :status, :string, default: "connected"
    field :linear_team_id, :string
    field :linear_team_name, :string
    field :disconnected_at, :utc_datetime

    belongs_to :project, Project
    belongs_to :connected_by_user, User

    timestamps()
  end

  def changeset(connection, attrs) do
    connection
    |> cast(attrs, [
      :project_id,
      :api_key,
      :status,
      :linear_team_id,
      :linear_team_name,
      :connected_by_user_id,
      :disconnected_at
    ])
    |> validate_required([:project_id, :status])
    |> validate_inclusion(:status, ["connected", "disconnected"])
    |> unique_constraint(:project_id)
  end
end
