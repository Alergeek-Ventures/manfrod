defmodule Mix.Tasks.Slack.Export do
  @shortdoc "Export recent Slack messages for memory classification dataset"
  @moduledoc """
  Pulls recent messages from all Slack channels/DMs the bot has access to
  and saves them to eval/slack_raw.json for manual labeling.

  Usage:
    mix slack.export             # 30 messages per channel (default)
    mix slack.export 50          # 50 messages per channel

  Output: eval/slack_raw.json — do NOT commit this file (add to .gitignore).
  Next step: pick samples from the raw export and label them in eval/dataset.json.
  """

  use Mix.Task

  require Logger

  @default_limit 30
  # 1.2s between channel history fetches (stays under Tier 3: 50 req/min)
  @history_delay_ms 1_200
  # 0.3s between users.info lookups (Tier 4: 100 req/min)
  @user_delay_ms 300
  # 0.5s between page fetches in pagination
  @page_delay_ms 500

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.start")

    token = Application.get_env(:manfrod, :slack_bot_token)
    unless token, do: Mix.raise("SLACK_BOT_TOKEN not configured in .env")

    limit =
      case args do
        [n | _] -> String.to_integer(n)
        [] -> @default_limit
      end

    info("Fetching workspace info...")
    {team_id, team_name} = fetch_workspace(token)
    info("Workspace: #{team_name} (#{team_id})")

    info("Listing joined channels and DMs...")
    channels = list_all_channels(token)
    info("Found #{length(channels)} channels/DMs")

    user_cache = :ets.new(:slack_user_cache, [:set, :private])

    info("Fetching message history (#{limit} messages per channel)...")

    exported =
      Enum.map(channels, fn ch ->
        label = channel_label(ch)
        info("  → #{label}")

        messages = fetch_history(token, ch["id"], limit)
        enriched = enrich_messages(token, messages, user_cache)

        Process.sleep(@history_delay_ms)

        %{
          id: ch["id"],
          name: ch["name"],
          is_private: ch["is_private"] || false,
          is_im: ch["is_im"] || false,
          # Slack user ID on the other side of a DM
          dm_user_id: ch["user"],
          # Best-guess based on channel name conventions:
          # "av-x-<slug>" → project_public_client
          # "prywatnie-o-<slug>" → project_internal
          # is_im → dm
          # everything else → company (to be confirmed by human)
          guessed_kind: guess_channel_kind(ch),
          message_count: length(enriched),
          messages: enriched
        }
      end)

    total = Enum.sum(Enum.map(exported, & &1.message_count))

    output = %{
      exported_at: DateTime.utc_now() |> DateTime.to_iso8601(),
      workspace_id: team_id,
      workspace_name: team_name,
      channel_count: length(exported),
      total_messages: total,
      channels: exported
    }

    File.mkdir_p!("eval")
    path = "eval/slack_raw.json"
    File.write!(path, Jason.encode!(output, pretty: true))

    info("")
    info("Saved #{total} messages from #{length(exported)} channels to #{path}")
    info("")
    info("Next steps:")
    info("  1. Open eval/slack_raw.json and review messages")
    info("  2. Copy interesting samples to eval/dataset.json (see eval/dataset_template.json)")

    info(
      "  3. Fill in labels: channel_kind, expected_action, target_scope, safety_class, fact_kind, requires_review, reason"
    )

    info("  4. Run: mix eval.memory")
    info("")
    info("⚠️  Do NOT commit eval/slack_raw.json — it contains real Slack messages.")
  end

  # -- Slack API helpers -------------------------------------------------

  defp fetch_workspace(token) do
    case Manfrod.Slack.API.get("team.info", token, %{}) do
      {:ok, %{"team" => %{"id" => id, "name" => name}}} -> {id, name}
      _ -> {"unknown", "unknown"}
    end
  end

  defp list_all_channels(token), do: list_all_channels(token, nil, [])

  defp list_all_channels(token, cursor, acc) do
    params =
      %{types: "public_channel,private_channel,im", limit: 200, exclude_archived: true}
      |> then(fn p -> if cursor, do: Map.put(p, :cursor, cursor), else: p end)

    case Manfrod.Slack.API.get("conversations.list", token, params) do
      {:ok, %{"channels" => channels, "response_metadata" => %{"next_cursor" => next}}}
      when is_binary(next) and next != "" ->
        # Keep only channels the bot is actually a member of (is_member=true for public,
        # private channels and DMs always appear only if bot is in them)
        joined = Enum.filter(channels, &member?/1)
        Process.sleep(@page_delay_ms)
        list_all_channels(token, next, acc ++ joined)

      {:ok, %{"channels" => channels}} ->
        joined = Enum.filter(channels, &member?/1)
        acc ++ joined

      {:error, reason} ->
        Logger.warning("conversations.list failed: #{inspect(reason)}")
        acc
    end
  end

  # Public channels have explicit is_member field; private channels and DMs
  # only appear in the list if the bot is already in them.
  defp member?(%{"is_member" => true}), do: true
  defp member?(%{"is_im" => true}), do: true
  defp member?(%{"is_private" => true}), do: true
  defp member?(_), do: false

  defp fetch_history(token, channel_id, limit) do
    case Manfrod.Slack.API.get("conversations.history", token, %{
           channel: channel_id,
           limit: limit
         }) do
      {:ok, %{"messages" => messages}} ->
        messages

      {:error, reason} ->
        Logger.warning("conversations.history failed for #{channel_id}: #{reason}")
        []
    end
  end

  # Filter out system messages and bots, resolve user names
  defp enrich_messages(token, messages, user_cache) do
    messages
    |> Enum.reject(fn m ->
      m["subtype"] in ["channel_join", "channel_leave", "channel_archive", "channel_purpose"] or
        m["bot_id"] != nil
    end)
    |> Enum.map(fn m ->
      user_id = m["user"]
      user_name = if user_id, do: resolve_user_name(token, user_id, user_cache), else: nil

      %{
        ts: m["ts"],
        user_id: user_id,
        user_name: user_name,
        text: m["text"],
        thread_ts: m["thread_ts"],
        reply_count: m["reply_count"] || 0
      }
    end)
  end

  defp resolve_user_name(token, user_id, cache) do
    case :ets.lookup(cache, user_id) do
      [{^user_id, name}] ->
        name

      [] ->
        name =
          case Manfrod.Slack.API.get("users.info", token, %{user: user_id}) do
            {:ok, %{"user" => %{"real_name" => n}}} when is_binary(n) and n != "" -> n
            {:ok, %{"user" => %{"name" => n}}} when is_binary(n) -> n
            _ -> user_id
          end

        :ets.insert(cache, {user_id, name})
        Process.sleep(@user_delay_ms)
        name
    end
  end

  # -- Channel classification helpers ------------------------------------

  defp guess_channel_kind(%{"is_im" => true}), do: "dm"

  defp guess_channel_kind(%{"name" => name}) when is_binary(name) do
    cond do
      String.starts_with?(name, "av-x-") -> "project_public_client"
      String.starts_with?(name, "prywatnie-o-") -> "project_internal"
      true -> "company"
    end
  end

  defp guess_channel_kind(_), do: "unknown"

  defp channel_label(%{"is_im" => true, "user" => user}), do: "DM (user #{user})"
  defp channel_label(%{"is_im" => true}), do: "DM (unknown user)"
  defp channel_label(%{"name" => name, "is_private" => true}), do: "##{name} [private]"
  defp channel_label(%{"name" => name}), do: "##{name}"
  defp channel_label(%{"id" => id}), do: id

  defp info(msg), do: Mix.shell().info(msg)
end
