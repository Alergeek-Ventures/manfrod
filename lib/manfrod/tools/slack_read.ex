defmodule Manfrod.Tools.SlackRead do
  @moduledoc """
  Read-only access to Slack channels: recent channel history and thread
  replies, formatted with resolved channel/user names so the agent doesn't
  have to juggle raw IDs. Both default to where the agent is talking right
  now, so "read this thread" never needs an ID the agent doesn't have.
  Complements `Manfrod.Tools.SlackAdmin` (which only looks up channel IDs and
  deletes the bot's own messages).

  Requires the bot token to have `channels:history` (and `groups:history` /
  `im:history` / `mpim:history` for private channels/DMs it's a member of)
  plus `users:read` for name resolution.
  """

  alias Manfrod.Security.SecretDetector
  alias Manfrod.Slack.API

  @timezone "Europe/Warsaw"

  @thread_tail 100

  def definitions(ctx) do
    current = Map.get(ctx, :msg_ctx) || %{}

    [
      ReqLLM.Tool.new!(
        name: "read_slack_channel",
        description:
          "Read recent top-level messages from a Slack channel (the current one when no channel is given). Messages that have a thread show its thread_ts - pass it to read_slack_thread to read that thread. Use list_slack_channels first if you're not sure of a channel name.",
        parameter_schema: [
          channel: [
            type: :string,
            required: false,
            doc:
              "Channel name (e.g. 'general' or '#general') or Slack channel ID (e.g. 'C087QF130R3'). Omit for the current channel."
          ],
          limit: [
            type: :integer,
            required: false,
            doc: "Max messages to return, newest included (default 20, max 100)"
          ]
        ],
        callback: fn args -> read_slack_channel(args, current) end
      ),
      ReqLLM.Tool.new!(
        name: "read_slack_thread",
        description:
          "Read a Slack thread: its first message and its latest replies. Call with no arguments to read the thread you are in right now. For another thread, give its thread_ts (shown by read_slack_channel) and its channel.",
        parameter_schema: [
          channel: [
            type: :string,
            required: false,
            doc: "Channel name or Slack channel ID. Omit for the current channel."
          ],
          thread_ts: [
            type: :string,
            required: false,
            doc:
              "thread_ts of the thread's parent message, e.g. '1719000000.123456'. Omit for the current thread."
          ]
        ],
        callback: fn args -> read_slack_thread(args, current) end
      )
    ]
  end

  defp read_slack_channel(args, current) do
    token = bot_token()
    limit = args |> Map.get(:limit, 20) |> clamp_limit()

    with {:ok, channel_id} <- resolve_channel(token, Map.get(args, :channel), current),
         {:ok, messages} <- API.list_messages(token, channel_id, limit: limit) do
      format_messages(token, messages)
    else
      {:error, :no_channel} -> {:ok, "Nie wiem, który kanał odczytać - podaj nazwę kanału."}
      {:error, :not_found} -> {:ok, "Nie znalazłem kanału: #{Map.get(args, :channel)}"}
      {:error, reason} -> {:ok, "Nie udało się odczytać kanału: #{inspect(reason)}"}
    end
  end

  defp read_slack_thread(args, current) do
    token = bot_token()

    with {:ok, thread_ts} <- thread_ts(args, current),
         {:ok, channel_id} <- resolve_channel(token, Map.get(args, :channel), current),
         {:ok, messages} <- API.list_full_thread(token, channel_id, thread_ts) do
      format_messages(token, thread_tail(messages))
    else
      {:error, :no_thread} ->
        {:ok,
         "Podaj thread_ts wątku - pokazuje go read_slack_channel przy wiadomościach z odpowiedziami."}

      {:error, :no_channel} ->
        {:ok, "Nie wiem, w którym kanale jest ten wątek - podaj kanał."}

      {:error, :not_found} ->
        {:ok, "Nie znalazłem kanału: #{Map.get(args, :channel)}"}

      {:error, reason} ->
        {:ok, "Nie udało się odczytać wątku: #{inspect(reason)}"}
    end
  end

  defp thread_ts(args, current) do
    explicit = blank_to_nil(Map.get(args, :thread_ts))
    channel = blank_to_nil(Map.get(args, :channel))

    cond do
      explicit ->
        {:ok, explicit}

      channel in [nil, current[:channel]] and is_binary(current[:thread_ts]) ->
        {:ok, current[:thread_ts]}

      true ->
        {:error, :no_thread}
    end
  end

  defp thread_tail([root | replies]) when length(replies) > @thread_tail do
    [root | Enum.take(replies, -@thread_tail)]
  end

  defp thread_tail(messages), do: messages

  defp clamp_limit(limit) when is_integer(limit), do: limit |> max(1) |> min(100)
  defp clamp_limit(_), do: 20

  defp bot_token, do: Application.get_env(:manfrod, :slack_bot_token)

  defp resolve_channel(token, channel, current) do
    case blank_to_nil(channel) || current[:channel] do
      nil -> {:error, :no_channel}
      channel -> API.resolve_channel(token, channel)
    end
  end

  defp blank_to_nil(value) when is_binary(value) do
    if String.trim(value) == "", do: nil, else: String.trim(value)
  end

  defp blank_to_nil(_value), do: nil

  defp format_messages(_token, []), do: {:ok, "Brak wiadomości."}

  defp format_messages(token, messages) do
    user_names = resolve_user_names(token, messages)

    lines =
      Enum.map(messages, fn msg ->
        time = format_ts(Map.get(msg, "ts"))
        author = author_name(msg, user_names)
        text = redacted_text(msg, user_names)
        thread_note = thread_note(msg)

        "[#{time}] #{author}: #{text}#{thread_note}"
      end)

    {:ok, Enum.join(lines, "\n")}
  end

  defp redacted_text(msg, user_names) do
    raw = Map.get(msg, "text", "")

    if SecretDetector.contains_secret?(raw) do
      "[wiadomość ukryta — wygląda na klucz API/hasło]"
    else
      resolve_mentions(raw, user_names)
    end
  end

  defp thread_note(%{"reply_count" => count, "ts" => ts}) when is_integer(count) and count > 0,
    do:
      " (#{count} #{if count == 1, do: "odpowiedź", else: "odpowiedzi"} w wątku, thread_ts: #{ts})"

  defp thread_note(_msg), do: ""

  defp author_name(%{"bot_id" => bot_id, "username" => name}, _user_names)
       when is_binary(bot_id) and is_binary(name) and name != "",
       do: "#{name} (bot)"

  defp author_name(%{"bot_id" => bot_id, "bot_profile" => %{"name" => name}}, _user_names)
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
