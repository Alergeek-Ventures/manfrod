defmodule Manfrod.Tools.SlackAdmin do
  @moduledoc """
  Slack workspace utility tools: looking up channel IDs and deleting the
  bot's own messages. `delete_slack_message` exists for when a user
  explicitly asks the bot to remove something it posted — the agent isn't
  expected to reach for it on its own initiative.
  """

  alias Manfrod.Slack.API

  def definitions(_ctx) do
    [
      ReqLLM.Tool.new!(
        name: "list_slack_channels",
        description:
          "List Slack channels the bot can see, with their IDs and names. Use this to look up a channel_id when a user refers to a channel by name (e.g. for show_desk_map's channel_id argument).",
        parameter_schema: [
          name_filter: [
            type: :string,
            doc: "Optional case-insensitive substring to filter channel names by"
          ]
        ],
        callback: fn args -> list_slack_channels(args) end
      ),
      ReqLLM.Tool.new!(
        name: "delete_slack_message",
        description:
          "Delete a message the bot previously posted, given its channel ID and message timestamp (ts). Only works on the bot's own messages. Only use this when a user explicitly asks you to remove a specific message — never delete messages on your own initiative.",
        parameter_schema: [
          channel_id: [
            type: :string,
            required: true,
            doc: "Slack channel ID, e.g. 'C087QF130R3'"
          ],
          ts: [
            type: :string,
            required: true,
            doc: "Message timestamp ('ts'), e.g. '1719000000.123456'"
          ]
        ],
        callback: fn args -> delete_slack_message(args) end
      )
    ]
  end

  defp list_slack_channels(args) do
    bot_token = Application.get_env(:manfrod, :slack_bot_token)

    case API.list_channels(bot_token) do
      {:ok, channels} ->
        channels
        |> Enum.filter(&matches_filter?(&1, Map.get(args, :name_filter)))
        |> format_channels()

      {:error, reason} ->
        {:ok, "Could not list Slack channels: #{inspect(reason)}"}
    end
  end

  defp matches_filter?(_channel, nil), do: true
  defp matches_filter?(_channel, ""), do: true

  defp matches_filter?(%{"name" => name}, filter) when is_binary(name) do
    String.contains?(String.downcase(name), String.downcase(filter))
  end

  defp matches_filter?(_channel, _filter), do: false

  defp format_channels([]), do: {:ok, "No matching channels found."}

  defp format_channels(channels) do
    lines =
      Enum.map(channels, fn channel ->
        name = Map.get(channel, "name", "?")
        id = Map.get(channel, "id", "?")
        visibility = if Map.get(channel, "is_private"), do: "private", else: "public"
        "- ##{name} (#{id}, #{visibility})"
      end)

    {:ok, "Channels:\n#{Enum.join(lines, "\n")}"}
  end

  defp delete_slack_message(%{channel_id: channel, ts: ts}) do
    bot_token = Application.get_env(:manfrod, :slack_bot_token)

    case API.delete_message(bot_token, channel, ts) do
      {:ok, _} -> {:ok, "Deleted the message."}
      {:error, reason} -> {:ok, "Could not delete the message: #{inspect(reason)}"}
    end
  end
end
