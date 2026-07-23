defmodule Manfrod.Memory.Classifier do
  @moduledoc """
  Passive memory classifier.

  Takes a batch of Slack messages from one channel, runs them through the
  LLM classifier in a single bulk call, and dispatches the appropriate action
  for each:

  - ignore        → do nothing
  - create_memory → embed + store as memory node
  - create_absence → save fact + node at the channel's default access, then
                     post Accept/Deny buttons proposing external/all — the
                     escalation is never applied without confirmation
  - create_meeting → store as fact with channel write_access
  - flag_sensitive → log silently, no write, no reply
  - ask_human     → save at default access immediately, then post a thread
                    reply with Accept/Deny buttons proposing wider access;
                    Accept widens the already-saved node, Deny/timeout leave
                    it at the default level (nothing is lost)
  """

  require Logger

  alias Manfrod.{Accounts, Events, Facts, LLM, Memory, Voyage}
  alias Manfrod.Memory.{Access, ChannelDetector, PendingConfirmations, PendingOps}
  alias Manfrod.Slack.API

  # Prompt content lives in priv/skills/memory/classifier.md, read at
  # runtime via Manfrod.Skills.read_prompt/1 so it can be hand-edited without
  # a recompile. Not a discoverable skill (no frontmatter) — this prompt is
  # always used in full, there's no relevance decision to make.
  defp system_prompt, do: Manfrod.Skills.read_prompt("memory/classifier.md")

  @doc """
  Classify a batch of messages from a Slack channel and dispatch actions.
  Single bulk LLM call for the entire batch.
  """
  @spec classify_batch([map()], String.t(), String.t() | nil, String.t()) :: :ok
  def classify_batch(messages, channel_id, channel_name, bot_token) do
    {:ok, write_access} = ChannelDetector.ensure_mapping(channel_id, channel_name)
    kind = resolve_kind(channel_id, channel_name, write_access)
    ensure_author_memberships(messages, channel_id)
    do_classify_batch(messages, channel_id, kind, write_access, bot_token)
  end

  # Anyone writing on a project channel is auto-enrolled as a project member,
  # so their DM/company-channel reads include the project's external levels.
  defp ensure_author_memberships(messages, channel_id) do
    case Access.get_active_mapping(channel_id) do
      %{project_id: project_id} when not is_nil(project_id) ->
        messages
        |> Enum.map(& &1["user"])
        |> Enum.uniq()
        |> Enum.each(fn slack_user_id ->
          case find_user_id(slack_user_id) do
            nil -> :ok
            user_id -> Access.ensure_membership!(user_id, project_id)
          end
        end)

      _ ->
        :ok
    end
  end

  defp resolve_kind(channel_id, channel_name, write_access) do
    case ChannelDetector.detect(channel_id, channel_name) do
      {:ok, kind, _client_id} ->
        kind

      {:error, :unmapped_channel} ->
        if Enum.any?(write_access, &String.starts_with?(&1, "external/")) do
          "project_external"
        else
          "company_channel"
        end
    end
  end

  defp do_classify_batch(messages, channel_id, kind, write_access, bot_token) do
    formatted =
      messages
      |> Enum.with_index()
      |> Enum.map(fn {msg, idx} -> "Message #{idx}:\n#{format_message(msg, kind)}" end)
      |> Enum.join("\n---\n")

    today = local_today()

    user_msg =
      "Current date: #{Date.to_iso8601(today)} (#{weekday_name(today)}).\n" <>
        "Classify each of the following #{length(messages)} message(s). " <>
        "Return a JSON array with exactly #{length(messages)} objects in the same order.\n\n" <>
        formatted

    msgs = [ReqLLM.Context.system(system_prompt()), ReqLLM.Context.user(user_msg)]

    case LLM.generate_text(msgs, purpose: :classifier) do
      {:ok, response} ->
        raw = ReqLLM.Response.text(response) || "[]"

        case parse_bulk_response(raw) do
          {:ok, results} ->
            results
            |> Enum.zip(messages)
            |> Enum.with_index()
            |> Enum.each(fn {{result, message}, idx} ->
              # Drain any op the agent flagged for this exact message. A flag
              # forces the action (agent already decided) and overrides the
              # LLM's choice; graph ops are executed verbatim afterwards.
              pending = PendingOps.take(channel_id, message["ts"])
              {action, result} = apply_pending_flag(pending.flag, result)
              reasoning = Map.get(result, "reasoning", "")
              flagged = if pending.flag, do: " (agent-flagged)", else: ""

              Logger.info(
                "Classifier [#{channel_id}] msg #{idx}: #{action}#{flagged} — #{reasoning}"
              )

              dispatch_action(action, result, message, channel_id, kind, write_access, bot_token)
              run_ops(pending.ops)
            end)

          {:error, reason} ->
            Logger.warning(
              "Classifier bulk parse failed: #{reason} / raw: #{String.slice(raw, 0, 200)}"
            )
        end

      {:error, reason} ->
        Logger.error("Classifier LLM error: #{inspect(reason)}")
    end

    :ok
  end

  # -- Action dispatch ---------------------------------------------------------

  defp dispatch_action(
         "ignore",
         _result,
         _message,
         _channel_id,
         _kind,
         _write_access,
         _bot_token
       ),
       do: :ok

  defp dispatch_action(
         "flag_sensitive",
         _result,
         message,
         channel_id,
         _kind,
         _write_access,
         _bot_token
       ) do
    Logger.warning(
      "Classifier flag_sensitive: channel=#{channel_id} user=#{message["user"]} ts=#{message["ts"]}"
    )

    Events.broadcast(:sensitive_content_detected, %{
      source: :classifier,
      meta: %{
        slack_channel_id: channel_id,
        slack_user_id: message["user"],
        ts: message["ts"]
      }
    })

    :ok
  end

  defp dispatch_action(
         "create_memory",
         result,
         message,
         channel_id,
         _kind,
         write_access,
         _bot_token
       ) do
    note = note_or_text(result, message)
    user_id = find_user_id(message["user"])

    if user_id == nil do
      Logger.debug("Classifier create_memory: skipping — user #{message["user"]} not in system")
    else
      case Voyage.embed_query(note) do
        {:ok, embedding} ->
          Memory.create_node(user_id, write_access, %{
            content: note,
            embedding: embedding,
            project_id: project_id_for_channel(channel_id)
          })

        {:error, reason} ->
          Logger.error("Classifier embed error: #{inspect(reason)}")
      end
    end

    :ok
  end

  # Absence is saved at the channel's default access — never escalated
  # automatically. Sharing to external/all always requires human confirmation
  # via the escalation buttons (node + fact are widened together on accept).
  defp dispatch_action(
         "create_absence",
         result,
         message,
         channel_id,
         kind,
         write_access,
         bot_token
       ) do
    text = message["text"] || ""
    user_name = message["user_name"] || message["user"] || "unknown"
    user_id = find_user_id(message["user"])
    {start_date, end_date} = absence_dates(result)

    # Fact value keeps the resolved conclusion first; the literal message stays
    # as provenance. The key carries the resolved start date, not "today".
    key = "absence:#{user_name}:#{start_date}"
    value = "#{start_date}..#{end_date} — \"#{text}\""
    Facts.set_fact(key, value, write_access, user_id)

    if user_id do
      note = note_or_text(result, message)

      case Voyage.embed_query(note) do
        {:ok, embedding} ->
          node_attrs = %{
            content: note,
            embedding: embedding,
            project_id: project_id_for_channel(channel_id)
          }

          case Memory.create_node(user_id, write_access, node_attrs) do
            {:ok, node} ->
              maybe_propose_absence_escalation(
                channel_id,
                kind,
                message["ts"],
                node,
                key,
                write_access,
                bot_token
              )

            {:error, reason} ->
              Logger.error("Classifier create_absence node error: #{inspect(reason)}")
          end

        {:error, reason} ->
          Logger.error("Classifier create_absence embed error: #{inspect(reason)}")
      end
    end

    :ok
  end

  defp dispatch_action(
         "create_meeting",
         _result,
         message,
         channel_id,
         _kind,
         write_access,
         _bot_token
       ) do
    text = message["text"] || ""
    ts = message["ts"] || "0"
    key = "meeting:#{channel_id}:#{ts}"
    Facts.set_fact(key, text, write_access, "system")
    :ok
  end

  defp dispatch_action("ask_human", result, message, channel_id, kind, write_access, bot_token) do
    note = note_or_text(result, message)
    original_ts = message["ts"]
    user_id = find_user_id(message["user"])

    with {:ok, target_level} <- escalation_target(channel_id, kind, write_access),
         {:user, uid} when not is_nil(uid) <- {:user, user_id},
         {:ok, embedding} <- Voyage.embed_query(note),
         {:ok, node} <-
           Memory.create_node(uid, write_access, %{
             content: note,
             embedding: embedding,
             project_id: project_id_for_channel(channel_id)
           }) do
      post_escalation_question(
        channel_id,
        original_ts,
        node,
        target_level,
        write_access,
        bot_token
      )
    else
      {:user, nil} ->
        Logger.debug("Classifier ask_human: skipping — user #{message["user"]} not in system")

      {:error, reason} ->
        Logger.info("Classifier ask_human skipped for #{channel_id}: #{inspect(reason)}")
    end

    :ok
  end

  defp dispatch_action(unknown, _result, _message, _channel_id, _kind, _write_access, _bot_token) do
    Logger.warning("Classifier unknown action: #{unknown}")
    :ok
  end

  # -- Agent-flagged ops -------------------------------------------------------

  # No flag: use the LLM's own decision for this message.
  defp apply_pending_flag(nil, result), do: {Map.get(result, "action", "ignore"), result}

  # Flagged: force the agent's action and merge any resolved fields (dates for
  # absences, authored content for notes). The LLM-generated note is kept for
  # quality unless the agent supplied explicit content.
  defp apply_pending_flag(flag, result) do
    result =
      result
      |> maybe_override("note", Map.get(flag, :content))
      |> maybe_override("start_date", Map.get(flag, :start_date))
      |> maybe_override("end_date", Map.get(flag, :end_date))

    {flag.action, result}
  end

  defp maybe_override(result, _key, nil), do: result
  defp maybe_override(result, key, value), do: Map.put(result, key, value)

  # Execute standalone graph ops flagged by the agent. These carry the caller's
  # provenance/access so the batch stays the single execution point.
  defp run_ops(ops) do
    Enum.each(ops, fn
      {:escalate, %{node_id: id, level: level, readable_levels: rl}} ->
        Memory.escalate_note_access(id, level, rl)

      {:delete, %{node_id: id, user_id: uid}} ->
        Memory.delete_node(uid, id)

      {:link, %{a: a, b: b, user_id: uid}} ->
        Memory.create_link(uid, a, b)

      {:unlink, %{a: a, b: b, user_id: uid}} ->
        Memory.delete_link(uid, a, b)

      other ->
        Logger.warning("Classifier: unknown pending op #{inspect(other)}")
    end)
  end

  # -- Result helpers ----------------------------------------------------------

  # Reformulated third-person note from the classifier; falls back to the raw
  # message text if the model didn't provide one.
  defp note_or_text(result, message) do
    case Map.get(result, "note") do
      note when is_binary(note) and note != "" -> note
      _ -> message["text"] || ""
    end
  end

  defp absence_dates(result) do
    today = local_today() |> Date.to_iso8601()
    start_date = valid_iso_date(result["start_date"]) || today
    end_date = valid_iso_date(result["end_date"]) || start_date
    {start_date, end_date}
  end

  defp valid_iso_date(value) when is_binary(value) do
    case Date.from_iso8601(value) do
      {:ok, _} -> value
      _ -> nil
    end
  end

  defp valid_iso_date(_), do: nil

  defp local_today do
    DateTime.now!("Europe/Warsaw") |> DateTime.to_date()
  end

  defp weekday_name(date) do
    Enum.at(
      ~w(Monday Tuesday Wednesday Thursday Friday Saturday Sunday),
      Date.day_of_week(date) - 1
    )
  end

  # Absence escalation to external/all is proposed from any channel except
  # client channels (cross-client leak risk) — never applied automatically.
  defp maybe_propose_absence_escalation(
         channel_id,
         kind,
         original_ts,
         node,
         fact_key,
         write_access,
         bot_token
       ) do
    cond do
      kind == "project_external" ->
        :ok

      "external/all" in write_access ->
        :ok

      true ->
        post_escalation_question(
          channel_id,
          original_ts,
          node,
          "external/all",
          write_access,
          bot_token,
          fact_key: fact_key
        )
    end
  end

  defp post_escalation_question(
         channel_id,
         original_ts,
         node,
         target_level,
         write_access,
         bot_token,
         opts \\ []
       ) do
    prompt =
      "Zapisałem notatkę:\n> #{node.content}\n" <>
        "Poziom: `#{Enum.join(write_access, ", ")}`. Czy zapisać ją też jako `#{target_level}`?"

    blocks = [
      %{type: "section", text: %{type: "mrkdwn", text: prompt}},
      %{
        type: "actions",
        elements: [
          %{
            type: "button",
            action_id: "memory_escalation_accept",
            style: "primary",
            text: %{type: "plain_text", text: "Tak, zapisz szerzej", emoji: true}
          },
          %{
            type: "button",
            action_id: "memory_escalation_deny",
            text: %{type: "plain_text", text: "Nie, zostaw", emoji: true}
          }
        ]
      }
    ]

    case API.post("chat.postMessage", bot_token, %{
           channel: channel_id,
           thread_ts: original_ts,
           text: prompt,
           blocks: blocks
         }) do
      {:ok, %{"ts" => bot_ts}} ->
        PendingConfirmations.put(bot_ts, channel_id, %{
          node_id: node.id,
          target_level: target_level,
          write_access: write_access,
          fact_key: Keyword.get(opts, :fact_key)
        })

        Logger.info(
          "Classifier ask_human: posted escalation buttons on #{channel_id}/#{original_ts}"
        )

      {:error, reason} ->
        Logger.error("Classifier ask_human: failed to post: #{inspect(reason)}")
    end
  end

  @doc """
  Resolve an escalation confirmation from a button click.

  `:accept` widens the already-saved node's access to the proposed target
  level; `:deny` leaves it at the default. Either way the pending entry is
  removed and the question message is updated to reflect the outcome.
  """
  @spec resolve_confirmation(:accept | :deny, String.t(), String.t(), String.t()) :: :ok
  def resolve_confirmation(decision, channel_id, bot_ts, bot_token) do
    case PendingConfirmations.get(bot_ts) do
      {:ok, ^channel_id,
       %{node_id: node_id, target_level: target, write_access: write_access} = payload} ->
        PendingConfirmations.delete(bot_ts)

        outcome =
          case decision do
            :accept ->
              widen_fact_access(Map.get(payload, :fact_key), target)

              case Memory.escalate_note_access(node_id, target, write_access) do
                {:ok, _node} ->
                  "✅ Zapisane też jako `#{target}`."

                {:error, reason} ->
                  Logger.warning(
                    "Classifier escalation failed for #{node_id}: #{inspect(reason)}"
                  )

                  "⚠️ Nie udało się rozszerzyć dostępu (#{inspect(reason)}) — notatka zostaje na poziomie standardowym."
              end

            :deny ->
              "👌 OK, notatka zostaje na poziomie `#{Enum.join(write_access, ", ")}`."
          end

        API.post("chat.update", bot_token, %{
          channel: channel_id,
          ts: bot_ts,
          text: outcome,
          blocks: [%{type: "section", text: %{type: "mrkdwn", text: outcome}}]
        })

        :ok

      _ ->
        Logger.debug("Classifier resolve_confirmation: no pending entry for #{bot_ts}")
        :ok
    end
  end

  defp widen_fact_access(nil, _target), do: :ok

  defp widen_fact_access(fact_key, target) do
    case Facts.add_access(fact_key, target) do
      {:ok, _fact} ->
        :ok

      {:error, reason} ->
        Logger.warning("Classifier widen_fact_access failed for #{fact_key}: #{inspect(reason)}")
        :ok
    end
  end

  defp escalation_target(_channel_id, "project_external", _write_access),
    do: {:error, :external_channel}

  defp escalation_target(_channel_id, "priv_channel", _write_access), do: {:ok, "external/all"}

  defp escalation_target(channel_id, "project_internal", _write_access) do
    case Access.client_id_for_channel(channel_id) do
      nil -> {:error, :missing_client_mapping}
      client_id -> {:ok, "external/#{client_id}"}
    end
  end

  defp escalation_target(_channel_id, _kind, _write_access), do: {:error, :missing_client_target}

  # -- Helpers -----------------------------------------------------------------

  defp format_message(message, kind) do
    channel_type = channel_type_description(kind)
    resolved_scope = resolved_scope(kind)
    user = message["user_name"] || message["user"] || "unknown"
    text = message["text"] || ""

    """
    Channel: #{kind}
    Channel type: #{channel_type}
    Resolved scope: #{resolved_scope}
    User: #{user}
    Message: "#{text}"
    """
  end

  defp channel_type_description("project_internal"),
    do: "private project channel (team only — client cannot see this)"

  defp channel_type_description("project_external"),
    do: "shared with client (external/<client_id>)"

  defp channel_type_description("company_channel"), do: "internal company channel"
  defp channel_type_description("priv_channel"), do: "direct message / private channel (priv)"
  defp channel_type_description(_), do: "unknown"

  defp resolved_scope("priv_channel"), do: "internal (v1; secret/<id> in v2)"
  defp resolved_scope("company_channel"), do: "internal"
  defp resolved_scope("project_internal"), do: "internal"
  defp resolved_scope("project_external"), do: "internal + external/<client_id>"
  defp resolved_scope(_), do: "none"

  defp parse_bulk_response(raw) do
    cleaned =
      raw
      |> String.replace(~r/```json\s*/i, "")
      |> String.replace(~r/```/, "")
      |> String.trim()

    case Jason.decode(cleaned) do
      {:ok, list} when is_list(list) -> {:ok, list}
      {:ok, _} -> {:error, "expected JSON array, got object or scalar"}
      {:error, reason} -> {:error, inspect(reason)}
    end
  end

  defp find_user_id(nil), do: nil

  defp find_user_id(slack_user_id) do
    case Accounts.get_user_by_slack_id(slack_user_id) do
      nil -> nil
      user -> user.id
    end
  end

  # Project attribution comes straight from the channel mapping — same source
  # used to derive write_access — so a node's project is stamped at creation
  # and never depends on downstream provenance (conversation_id) that may be
  # missing.
  defp project_id_for_channel(channel_id) do
    case Access.get_active_mapping(channel_id) do
      %{project_id: project_id} -> project_id
      nil -> nil
    end
  end
end
