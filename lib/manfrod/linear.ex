defmodule Manfrod.Linear do
  @moduledoc """
  Project-scoped Linear connections — one read-only Personal API Key per
  project, connected/disconnected via `/linear-status` (see
  `Manfrod.Linear.Status`) and exposed to the agent via `Manfrod.Tools.Linear`.

  Unlike `Manfrod.Mcp` (per-user OAuth connections), these connections are
  keyed on `project_id`: everyone talking to the bot in a channel mapped to
  that project shares the same Linear context.
  """

  import Ecto.Query

  alias Manfrod.Linear.Client
  alias Manfrod.Linear.Connection
  alias Manfrod.Repo

  @doc "The connected Linear connection for a project, or `nil`."
  @spec get_connection(binary()) :: Connection.t() | nil
  def get_connection(project_id) do
    Repo.one(from c in Connection, where: c.project_id == ^project_id and c.status == "connected")
  end

  @doc "All connections (any status), preloaded with their project — for the admin panel."
  @spec list_connections() :: [Connection.t()]
  def list_connections do
    Repo.all(from c in Connection, preload: :project, order_by: [asc: c.inserted_at])
  end

  @doc """
  Verifies `api_key` against Linear (must resolve to exactly one team),
  then creates or reconnects the project's connection.

  Returns `{:ok, connection}`, `{:error, :invalid_key}` if the key doesn't
  authenticate, `{:error, :no_team_scoped}` if it isn't scoped to a single
  team, or `{:error, changeset}` on a persistence failure.
  """
  @spec connect(binary(), binary(), String.t()) ::
          {:ok, Connection.t()} | {:error, :invalid_key | :no_team_scoped | Ecto.Changeset.t()}
  def connect(project_id, user_id, api_key) do
    with {:ok, %{id: team_id, name: team_name}} <- Client.verify_key(api_key) do
      existing = Repo.get_by(Connection, project_id: project_id)

      (existing || %Connection{})
      |> Connection.changeset(%{
        project_id: project_id,
        api_key: api_key,
        status: "connected",
        linear_team_id: team_id,
        linear_team_name: team_name,
        connected_by_user_id: user_id,
        disconnected_at: nil
      })
      |> Repo.insert_or_update()
    else
      {:error, :unauthorized} -> {:error, :invalid_key}
      {:error, :no_team_scoped} -> {:error, :no_team_scoped}
      {:error, _reason} -> {:error, :invalid_key}
    end
  end

  @doc "Marks a project's connection disconnected. No-op if there is none."
  @spec disconnect(binary()) :: {:ok, Connection.t() | nil} | {:error, Ecto.Changeset.t()}
  def disconnect(project_id) do
    case Repo.get_by(Connection, project_id: project_id) do
      nil ->
        {:ok, nil}

      conn ->
        conn
        |> Connection.changeset(%{
          status: "disconnected",
          disconnected_at: DateTime.utc_now() |> DateTime.truncate(:second)
        })
        |> Repo.update()
    end
  end
end
