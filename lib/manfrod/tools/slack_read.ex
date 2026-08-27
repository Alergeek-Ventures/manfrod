defmodule Manfrod.Tools.SlackRead do
  @moduledoc """
  Read-only access to other Slack channels: recent channel history and
  thread replies, formatted with resolved channel/user names so the agent
  doesn't have to juggle raw IDs. Complements `Manfrod.Tools.SlackAdmin`
  (which only looks up channel IDs and deletes the bot's own messages).

  Requires the bot token to have `channels:history` (and `groups:history` /
  `im:history` / `mpim:history` for private channels/DMs it's a member of)
  plus `users:read` for name resolution.
  """

  alias Manfrod.Slack.API

  @timezone "Europe/Warsaw"

  def definitions(_ctx) do
    [
      ReqLLM.Tool.new!(
        name: "read_slack_channel",
        description:
          "Read recent messages from a Slack channel other than the current one. Use to catch up on what's been discussed elsewhere. Give a channel name (with or without '#') or a channel ID — use list_slack_channels first if you're not sure of the name.",
        parameter_schema: [
          channel: [
            type: :string,
            required: true,
            doc:
              "Channel name (e.g. 'general' or '#general') or Slack channel ID (e.g. 'C087QF130R3')"
          ],
          limit: [
            type: :integer,
            required: false,
            doc: "Max messages to return, newest included (default 20, max 100)"
          ]
        ],
        callback: fn args -> read_slack_channel(args) end
      ),
      ReqLLM.Tool.new!(
        name: "read_slack_thread",
        description:
          "Read all replies in a specific Slack thread, given the channel and the parent message's timestamp (ts). Use after read_slack_channel shows a message with replies you want to expand.",
        parameter_schema: [
          channel: [
            type: :string,
            required: true,
            doc: "Channel name (e.g. 'general' or '#general') or Slack channel ID"
          ],
          thread_ts: [
            type: :string,
            required: true,
            doc: "Timestamp ('ts') of the thread's parent message, e.g. '1719000000.123456'"
          ]
        ],
        callback: fn args -> read_slack_thread(args) end
      )
    ]
  end

  defp read_slack_channel(args) do
    token = bot_token()
    limit = args |> Map.get(:limit, 20) |> clamp_limit()

    with {:ok, channel_id} <- resolve_channel(token, Map.get(args, :channel)),
         {:ok, messages} <- API.list_messages(token, channel_id, limit: limit) do
      format_messages(token, messages)
    else
      {:error, :not_found} -> {:ok, "Nie znalazłem kanału: #{Map.get(args, :channel)}"}
      {:error, reason} -> {:ok, "Nie udało się odczytać kanału: #{inspect(reason)}"}
    end
  end

  defp read_slack_thread(%{thread_ts: thread_ts} = args) do
    token = bot_token()

    with {:ok, channel_id} <- resolve_channel(token, Map.get(args, :channel)),
         {:ok, messages} <- API.list_thread_replies(token, channel_id, thread_ts) do
      format_messages(token, messages)
    else
      {:error, :not_found} -> {:ok, "Nie znalazłem kanału: #{Map.get(args, :channel)}"}
      {:error, reason} -> {:ok, "Nie udało się odczytać wątku: #{inspect(reason)}"}
    end
  end

  defp clamp_limit(limit) when is_integer(limit), do: limit |> max(1) |> min(100)
  defp clamp_limit(_), do: 20

  defp bot_token, do: Application.get_env(:manfrod, :slack_bot_token)

  defp resolve_channel(token, channel), do: API.resolve_channel(token, channel)

  defp format_messages(_token, []), do: {:ok, "Brak wiadomości."}

  defp format_messages(token, messages) do
    user_names = resolve_user_names(token, messages)

    lines =
      Enum.map(messages, fn msg ->
        time = format_ts(Map.get(msg, "ts"))
        author = author_name(msg, user_names)
        text = resolve_mentions(Map.get(msg, "text", ""), user_names)
        thread_note = thread_note(msg)

        "[#{time}] #{author}: #{text}#{thread_note}"
      end)

    {:ok, Enum.join(lines, "\n")}
  end

  defp thread_note(%{"reply_count" => count}) when is_integer(count) and count > 0,
    do: " (#{count} #{if count == 1, do: "odpowiedź", else: "odpowiedzi"} w wątku)"

  defp thread_note(_msg), do: ""

  defp author_name(%{"bot_id" => bot_id, "username" => name}, _user_names)
       when is_binary(bot_id) and is_binary(name) and name != "",
       do: "#{name} (bot)"

  defp author_name(%{"bot_id" => bot_id}, _user_names) when is_binary(bot_id), do: "bot"

  defp author_name(%{"user" => user_id}, user_names) do
    Map.get(user_names, user_id, user_id)
  end

  defp author_name(_msg, _user_names), do: "?"

  defp resolve_user_names(token, messages) do
    ids =
      messages
      |> Enum.flat_map(&mentioned_user_ids/1)
      |> Enum.uniq()

    Map.new(ids, fn id -> {id, fetch_name(token, id)} end)
  end

  defp mentioned_user_ids(msg) do
    author =
      case msg do
        %{"user" => user_id} -> [user_id]
        _ -> []
      end

    mentions = Regex.scan(~r/<@([A-Z0-9]+)>/, Map.get(msg, "text", ""), capture: :all_but_first)
    author ++ List.flatten(mentions)
  end

  defp fetch_name(token, user_id) do
    case API.fetch_user_name(token, user_id) do
      {:ok, name} -> name
      :error -> user_id
    end
  end

  defp resolve_mentions(text, user_names) do
    Regex.replace(~r/<@([A-Z0-9]+)>/, text, fn _whole, id ->
      "@#{Map.get(user_names, id, id)}"
    end)
  end

  defp format_ts(nil), do: "?"

  defp format_ts(ts) when is_binary(ts) do
    ts
    |> String.to_float()
    |> trunc()
    |> DateTime.from_unix!()
    |> DateTime.shift_zone!(@timezone)
    |> Calendar.strftime("%Y-%m-%d %H:%M")
  end
end
