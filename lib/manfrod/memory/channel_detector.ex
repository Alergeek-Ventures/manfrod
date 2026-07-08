defmodule Manfrod.Memory.ChannelDetector do
  @moduledoc """
  Detects channel type from Slack channel name/ID using regex patterns.

  Patterns:
  - DM (D…)              → priv_channel
  - av-x-<slug>          → project_external (client_id = slug)
  - prywatnie-o-<slug>   → project_internal (slug preserved)
  - anything else        → internal fallback

  Exact convention matches are activated only when the referenced project
  already exists. Missing projects create pending proposals and fall back to
  internal until an admin confirms the mapping.
  """

  require Logger

  alias Manfrod.{Repo}
  alias Manfrod.Memory.{Access, ChannelMapping, Project}

  @doc """
  Detect the channel kind from channel_id and channel_name.
  Returns {:ok, kind, client_id | nil}.
  """
  @spec detect(String.t(), String.t() | nil) ::
          {:ok, String.t(), String.t() | nil} | {:error, :unmapped_channel}
  def detect("D" <> _, _channel_name), do: {:ok, "priv_channel", nil}

  def detect(_channel_id, channel_name) when is_binary(channel_name) do
    cond do
      Regex.match?(~r/^av-x-(.+)$/, channel_name) ->
        [_, slug] = Regex.run(~r/^av-x-(.+)$/, channel_name)
        {:ok, "project_external", slug}

      Regex.match?(~r/^prywatnie-o-(.+)$/, channel_name) ->
        [_, slug] = Regex.run(~r/^prywatnie-o-(.+)$/, channel_name)
        {:ok, "project_internal", slug}

      true ->
        {:error, :unmapped_channel}
    end
  end

  def detect(_channel_id, nil), do: {:error, :unmapped_channel}

  @doc """
  Ensure an active ChannelMapping exists for the channel.
  Auto-creates one from regex detection if missing.

  Returns {:ok, write_access_list}. Channels that don't match any known pattern
  fall back to internal.
  """
  @spec ensure_mapping(String.t(), String.t() | nil) :: {:ok, [String.t()]}
  def ensure_mapping(channel_id, channel_name) do
    case Access.get_active_mapping(channel_id) do
      %ChannelMapping{} = m ->
        {:ok, ChannelMapping.write_access(m)}

      nil ->
        case detect(channel_id, channel_name) do
          {:ok, "project_external", slug} ->
            ensure_project_external(channel_id, channel_name, slug)

          {:ok, "project_internal", slug} ->
            ensure_project_internal(channel_id, channel_name, slug)

          {:ok, "priv_channel", _} ->
            {:ok, ["internal"]}

          _ ->
            Logger.info(
              "ChannelDetector: #{channel_id} (#{channel_name || "unknown"}) has no mapping, defaulting to internal"
            )

            {:ok, ["internal"]}
        end
    end
  end

  defp ensure_project_external(channel_id, channel_name, slug) do
    case Repo.get_by(Project, slug: slug) do
      nil ->
        create_pending_mapping(channel_id, channel_name, slug, slug)
        {:ok, ["internal"]}

      project ->
        upsert_mapping(channel_id, %{
          slack_channel_id: channel_id,
          slack_channel_name: channel_name,
          project_id: project.id,
          client_id: slug,
          source: "auto_detected",
          status: "active"
        })

        Logger.info(
          "ChannelDetector: auto-mapped #{channel_id} (#{channel_name}) → external/#{slug}"
        )

        {:ok, ["internal", "external/#{slug}"]}
    end
  end

  defp ensure_project_internal(channel_id, channel_name, slug) do
    case Repo.get_by(Project, slug: slug) do
      nil ->
        create_pending_mapping(channel_id, channel_name, slug, nil)
        {:ok, ["internal"]}

      project ->
        upsert_mapping(channel_id, %{
          slack_channel_id: channel_id,
          slack_channel_name: channel_name,
          project_id: project.id,
          client_id: nil,
          source: "auto_detected",
          status: "active"
        })

        Logger.info(
          "ChannelDetector: auto-mapped #{channel_id} (#{channel_name}) → internal for #{slug}"
        )

        {:ok, ["internal"]}
    end
  end

  defp create_pending_mapping(channel_id, channel_name, slug, client_id) do
    attrs = %{
      slack_channel_id: channel_id,
      slack_channel_name: channel_name,
      source: "auto_detected",
      status: "pending",
      client_id: client_id
    }

    %ChannelMapping{}
    |> ChannelMapping.changeset(attrs)
    |> Repo.insert(on_conflict: :nothing, conflict_target: :slack_channel_id)

    Logger.info(
      "ChannelDetector: pending mapping for #{channel_id} (#{channel_name}) — missing project #{slug}"
    )
  end

  defp upsert_mapping(channel_id, attrs) do
    case Repo.get_by(ChannelMapping, slack_channel_id: channel_id) do
      nil ->
        %ChannelMapping{}
        |> ChannelMapping.changeset(attrs)
        |> Repo.insert()

      mapping ->
        mapping
        |> ChannelMapping.changeset(attrs)
        |> Repo.update()
    end
  end
end
