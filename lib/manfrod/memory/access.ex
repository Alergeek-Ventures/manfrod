defmodule Manfrod.Memory.Access do
  @moduledoc """
  Single source of truth for access resolution.

  Access levels (ordered most-restricted → most-open):
    "secret/<user_id>"  — specific person(s) only (phase 2)
    "internal"          — all Manfrod employees, no clients
    "external/<slug>"   — team + specific client, e.g. "external/10bps"
    "external/all"      — team + ALL clients (vacations, absences)
    "public"            — everyone (phase 2)

  Each node/fact/conversation carries an `access` array. A reader can see
  a node if their readable_levels overlap with the node's access array
  (PostgreSQL: access && ARRAY[^readable_levels]).

  Write access is derived deterministically from the Slack channel — never
  from LLM judgment. Read access depends on the channel context the reader
  is currently in.
  """

  import Ecto.Query

  alias Manfrod.Repo
  alias Manfrod.Memory.{ChannelMapping, ProjectMembership}

  # ---------------------------------------------------------------------------
  # Write resolution — what access array to stamp on a new node
  # ---------------------------------------------------------------------------

  @doc """
  Resolve the access array to write on a new node based on the Slack channel.

  Returns {:ok, access_list}. Unmapped channels default to internal.
  """
  @spec resolve_for_write(slack_channel_id :: String.t()) :: {:ok, [String.t()]}
  def resolve_for_write("D" <> _ = _dm_channel) do
    # DMs: internal in v1 (secret/<user_id> in v2)
    {:ok, ["internal"]}
  end

  def resolve_for_write(channel_id) do
    case get_active_mapping(channel_id) do
      nil -> {:ok, ["internal"]}
      mapping -> {:ok, ChannelMapping.write_access(mapping)}
    end
  end

  # ---------------------------------------------------------------------------
  # Read resolution — what levels the reader can see in this channel context
  # ---------------------------------------------------------------------------

  @doc """
  Resolve the readable access levels for a user in a given Slack channel.

  Returns {:ok, readable_levels}. Unmapped channels default to internal.
  """
  @spec resolve_for_read(user_id :: binary(), slack_channel_id :: String.t()) ::
          {:ok, [String.t()]}
  def resolve_for_read(user_id, "D" <> _ = _dm_channel) do
    # DMs: see everything the user is a member of
    client_ids = client_ids_for_user(user_id)
    external_levels = Enum.map(client_ids, &"external/#{&1}")
    {:ok, ["internal"] ++ external_levels ++ ["external/all"]}
  end

  def resolve_for_read(user_id, channel_id) do
    case get_active_mapping(channel_id) do
      nil ->
        {:ok, ["internal", "external/all"]}

      %ChannelMapping{client_id: nil, project_id: nil} ->
        # Company channel: internal + user's projects' external levels + external/all
        client_ids = client_ids_for_user(user_id)
        external_levels = Enum.map(client_ids, &"external/#{&1}")
        {:ok, ["internal"] ++ external_levels ++ ["external/all"]}

      %ChannelMapping{client_id: nil, project_id: project_id} ->
        # Internal project channel: internal + this project's client-facing level.
        external_levels =
          case client_id_for_project(project_id) do
            nil -> []
            client_id -> ["external/#{client_id}"]
          end

        {:ok, ["internal"] ++ external_levels ++ ["external/all"]}

      %ChannelMapping{client_id: client_id} ->
        # Client channel: only that client's external level + external/all
        {:ok, ["external/#{client_id}", "external/all"]}
    end
  end

  # ---------------------------------------------------------------------------
  # Ecto dynamic WHERE clause
  # ---------------------------------------------------------------------------

  @doc """
  Returns an Ecto dynamic fragment for filtering nodes/facts by readable levels.

  Usage:
    where(query, ^Access.dynamic_where(readable_levels))
  """
  @spec dynamic_where([String.t()]) :: Ecto.Query.DynamicExpr.t()
  def dynamic_where(readable_levels) do
    dynamic([n], fragment("? && ?", n.access, ^readable_levels))
  end

  # ---------------------------------------------------------------------------
  # Project membership helpers
  # ---------------------------------------------------------------------------

  @doc """
  Idempotently insert a project membership. Called whenever a write happens
  on a project channel so the user is auto-enrolled.
  """
  @spec ensure_membership!(user_id :: binary(), project_id :: binary()) :: :ok
  def ensure_membership!(user_id, project_id) do
    %ProjectMembership{}
    |> ProjectMembership.changeset(%{
      user_id: user_id,
      project_id: project_id,
      source: "auto_detected"
    })
    |> Repo.insert(on_conflict: :nothing, conflict_target: [:user_id, :project_id])

    :ok
  end

  @doc """
  Check if a user is a member of a project.
  """
  @spec member?(user_id :: binary(), project_id :: binary()) :: boolean()
  def member?(user_id, project_id) do
    Repo.exists?(
      from pm in ProjectMembership,
        where: pm.user_id == ^user_id and pm.project_id == ^project_id
    )
  end

  # ---------------------------------------------------------------------------
  # Channel mapping lookup
  # ---------------------------------------------------------------------------

  @doc """
  Get the active channel mapping for a Slack channel ID, or nil if unmapped.
  """
  @spec get_active_mapping(String.t()) :: ChannelMapping.t() | nil
  def get_active_mapping(channel_id) do
    Repo.one(
      from cm in ChannelMapping,
        where: cm.slack_channel_id == ^channel_id and cm.status == "active",
        preload: [:project]
    )
  end

  @doc """
  Resolve the client id associated with a channel's project.

  For internal project channels this finds the active client-facing mapping for
  the same project. Returns nil when there is no deterministic client target.
  """
  @spec client_id_for_channel(String.t()) :: String.t() | nil
  def client_id_for_channel(channel_id) do
    case get_active_mapping(channel_id) do
      %ChannelMapping{client_id: client_id} when is_binary(client_id) ->
        client_id

      %ChannelMapping{project_id: project_id} when not is_nil(project_id) ->
        client_id_for_project(project_id)

      _ ->
        nil
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp client_ids_for_user(user_id) do
    Repo.all(
      from pm in ProjectMembership,
        join: cm in ChannelMapping,
        on: cm.project_id == pm.project_id and not is_nil(cm.client_id) and cm.status == "active",
        where: pm.user_id == ^user_id,
        select: cm.client_id,
        distinct: true
    )
  end

  defp client_id_for_project(project_id) do
    Repo.one(
      from cm in ChannelMapping,
        where:
          cm.project_id == ^project_id and cm.status == "active" and
            not is_nil(cm.client_id),
        select: cm.client_id,
        limit: 1
    )
  end
end
