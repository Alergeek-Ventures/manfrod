defmodule Manfrod.Memory.Access do
  @moduledoc """
  Single source of truth for access resolution.

  Access levels (ordered most-restricted → most-open):
    "private/<user_id>" — one person's own space; nobody else, not even the team
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

  ## Private is the default for DMs

  Anything said in a DM is written at `private/<user_id>` — the author's own
  space. Nothing a person tells the bot one-on-one reaches the team until
  they say so: the bot may *propose* widening it (to `internal`, and for
  things like absences also to `external/all`), but the escalation is only
  applied when the person confirms it (see `Manfrod.Memory.Classifier`).
  """

  import Ecto.Query

  alias Manfrod.Repo
  alias Manfrod.Memory.{ChannelMapping, ProjectMembership}

  # ---------------------------------------------------------------------------
  # Write resolution — what access array to stamp on a new node
  # ---------------------------------------------------------------------------

  @doc """
  The access level naming one person's own private space.
  """
  @spec private_level(user_id :: binary()) :: String.t()
  def private_level(user_id), do: "private/#{user_id}"

  @doc """
  Whether an access level (or array) is private to a single person.
  """
  @spec private?(String.t() | [String.t()]) :: boolean()
  def private?(levels) when is_list(levels), do: Enum.any?(levels, &private?/1)
  def private?(level) when is_binary(level), do: String.starts_with?(level, "private/")

  @doc """
  Resolve the access array to write on a new node based on the Slack channel.

  A DM writes to the author's own private space — pass `author_user_id` so it
  can be named. Without a known author the write falls back to `internal`,
  since an unattributable note can't be filed under anyone's private space.

  Returns {:ok, access_list}. Unmapped channels default to internal.
  """
  @spec resolve_for_write(slack_channel_id :: String.t(), author_user_id :: binary() | nil) ::
          {:ok, [String.t()]}
  def resolve_for_write(slack_channel_id, author_user_id \\ nil)

  def resolve_for_write("D" <> _ = _dm_channel, author_user_id) when is_binary(author_user_id) do
    {:ok, [private_level(author_user_id)]}
  end

  def resolve_for_write("D" <> _ = _dm_channel, nil) do
    {:ok, ["internal"]}
  end

  def resolve_for_write(channel_id, _author_user_id) do
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
    # DMs: the user's own private space plus everything they're a member of.
    # Only their own private level — one person's private notes are never
    # readable by anyone else, in any context.
    client_ids = client_ids_for_user(user_id)
    external_levels = Enum.map(client_ids, &"external/#{&1}")
    {:ok, [private_level(user_id), "internal"] ++ external_levels ++ ["external/all"]}
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
