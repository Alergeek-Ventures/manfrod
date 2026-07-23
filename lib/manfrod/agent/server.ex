defmodule Manfrod.Agent.Server do
  @moduledoc """
  Per-session Agent GenServer.

  Each session (Slack thread) gets its own Agent process with a shared
  conversation history, inbox, and flush timer — every participant in that
  thread is handled by the same process, not one process per author. Each
  inbound message still carries its own author's identity (`user_id`,
  `readable_levels`) via its event context, so tool calls and personal data
  act on behalf of whoever actually sent the triggering message. Processes
  are started on demand and terminate after an idle timeout, triggering
  memory extraction for every participant who spoke in the session.

  ## Lifecycle

  1. Started by `Agent.send_message/3` via DynamicSupervisor
  2. Processes messages, calls LLM, broadcasts events on per-user topic
  3. On idle timeout: broadcasts `:idle` per participant, terminates normally
  4. Next message for the same session starts a fresh process
  """

  use GenServer, restart: :temporary

  require Logger

  alias Manfrod.Accounts
  alias Manfrod.Agent.Init
  alias Manfrod.Agent.ResponseGate
  alias Manfrod.Agent.TypingRefresher
  alias Manfrod.Events
  alias Manfrod.LLM
  alias Manfrod.Memory
  alias Manfrod.Memory.Soul
  alias Manfrod.Repo
  alias Manfrod.Skills

  @system_prompt_intro """
  Current date, time, and timezone are provided in the [Current Context] section.
  Use them for scheduling reminders and interpreting relative time references like
  "tomorrow", "next Monday", etc. All reminder times should be in UTC (ISO8601).
  """

  # "Your Capabilities" is generated from every discovered tool's own
  # name/description (Manfrod.Tools.capabilities_text/1) instead of a
  # hand-maintained list here — dropping a new module in lib/manfrod/tools/
  # is enough to make the agent aware of it, nothing to edit in this file.
  @system_prompt_rest """
  ## Communication style
  - Default to 1-3 short sentences. No preamble, no restating the request, no
    summarizing what you're about to do — just do it and report the outcome.
  - Don't narrate tool calls ("Let me check...", "I'll search for..."); use
    the tool and report only the result.
  - Expand only when the user explicitly asks for detail, or the answer is
    inherently a list/steps/code that can't be shortened.
  - One question at a time if you need to ask something — don't front-load
    a checklist of clarifying questions.

  ## MANDATORY tool usage rules (NEVER skip these)

  ### Meetings
  - A meeting is confirmed → call create_note with the meeting details immediately.

  ### Reminders
  - User asks to be reminded of something → call set_reminder in the same response.

  Note context is injected with each message, showing relevant notes with
  their UUIDs. Use search_notes to find more, get_note to explore
  specific notes and their connections.

  Recurring reminders are linked to notes - the note content becomes your prompt
  when the reminder fires, along with all notes linked to it. Create a note with
  instructions first, then create the recurring reminder pointing to it.

  Google Calendar requires the user to have linked their Google account via the
  web app. If get_calendar_events returns a "no Google account" error, tell the
  user to sign in at the web app to connect their Google Calendar.

  Note context is scoped to your current channel's access level — you only see notes you're allowed to see in this context.
  """

  # Tool definitions live under lib/manfrod/tools/ (one module per domain,
  # auto-discovered by Manfrod.Tools — see its moduledoc). user_id/
  # readable_levels/write_access are baked into closures at call time;
  # `msg_ctx` (%{channel, ts}) identifies the inbound Slack message so
  # mutating tools can flag it for the passive memory batch instead of
  # writing directly.
  defp tool_context(user_id, readable_levels, write_access, msg_ctx) do
    %{
      user_id: user_id,
      readable_levels: readable_levels,
      write_access: write_access,
      msg_ctx: msg_ctx
    }
  end

  # Client API

  def start_link({user_id, session_key, write_access, readable_levels}) do
    GenServer.start_link(__MODULE__, {user_id, session_key, write_access, readable_levels},
      name: via(session_key)
    )
  end

  @doc """
  Registry-based name for per-session Agent processes.

  Keyed by `session_key` alone (not by user) so that every participant in a
  Slack thread shares the same process/conversation — multiple authors in one
  thread are handled as one shared session, not one isolated session each.
  """
  def via(session_key) do
    {:via, Registry, {Manfrod.Agent.Registry, session_key}}
  end

  # Server Callbacks

  # 1 minute debounce for testing (change back to 60 for production)
  @flush_delay :timer.minutes(1)

  # How many recent transcript lines the response gate gets to see.
  @transcript_window 12

  # Plain (gated) thread replies wait for a short pause before the response
  # gate evaluates the batch — so someone splitting a thought across several
  # messages doesn't get judged mid-sentence. DMs and @mentions skip this
  # entirely and are processed immediately.
  @gate_debounce_delay :timer.seconds(6)

  @impl true
  def init({user_id, session_key, write_access, readable_levels}) do
    system_message = ReqLLM.Context.system(build_system_prompt(user_id, session_key))

    # Subscribe to own PubSub topic for FlushHandler-like behavior
    Events.subscribe(user_id)

    # Restore any pending messages from DB (survives crashes/restarts). Scoped
    # to the session_key alone (not one user) so a shared multi-author thread
    # restores everyone's pending messages, not just the seed author's.
    pending = Memory.get_pending_messages_for_session(session_key)
    restored_messages = Enum.map(pending, &message_to_context/1)

    participants =
      pending
      |> Enum.map(& &1.user_id)
      |> MapSet.new()
      |> MapSet.put(user_id)

    # If we restored messages, add a system notice so agent knows it restarted
    messages =
      if restored_messages != [] do
        restart_notice =
          ReqLLM.Context.user(
            "[SYSTEM] Session was restarted (crash, update, or manual restart). " <>
              "Restored #{length(pending)} messages from conversation. " <>
              "Do not repeat actions already taken."
          )

        [system_message | restored_messages] ++ [restart_notice]
      else
        [system_message]
      end

    Logger.info("Agent.Server started for session #{session_key} (seed user #{user_id})")

    {:ok,
     %{
       user_id: user_id,
       session_key: session_key,
       write_access: write_access,
       readable_levels: readable_levels,
       participants: participants,
       messages: messages,
       transcript: [],
       inbox: [],
       flush_timer: nil,
       gate_debounce_timer: nil
     }}
  end

  defp build_system_prompt(user_id, session_key) do
    unless Repo.healthy?() do
      full_system_prompt(user_id) <> Soul.base_prompt()
    else
      context =
        Init.build_system_prompt(user_id,
          include_events: false,
          include_git: false,
          include_samples: false
        )

      soul = Memory.get_soul(user_id)
      user = Accounts.get_user!(user_id)
      current_context = build_current_context(user, session_key)

      base =
        if soul do
          context <> "\n\n" <> full_system_prompt(user_id)
        else
          context <> "\n\n" <> full_system_prompt(user_id) <> Soul.base_prompt()
        end

      base <> "\n\n" <> current_context <> skills_catalog()
    end
  end

  # Capabilities are generated from every discovered tool's own
  # name/description (see Manfrod.Tools) rather than hand-listed here. Real
  # per-message values (readable_levels/write_access/msg_ctx) aren't known
  # yet at prompt-build time, and don't need to be — they only feed tool
  # *callbacks*, never a tool's name/description, so placeholders are safe.
  defp full_system_prompt(user_id) do
    ctx = tool_context(user_id, nil, nil, %{channel: nil, ts: nil})
    capabilities = Manfrod.Tools.capabilities_text(ctx)

    @system_prompt_intro <>
      "\n## Your Capabilities\n" <> capabilities <> "\n\n" <> @system_prompt_rest
  end

  defp skills_catalog do
    case Skills.catalog_text() do
      nil -> ""
      text -> "\n\n" <> text
    end
  end

  @timezone "Europe/Warsaw"

  defp build_current_context(user, session_key) do
    now = DateTime.utc_now() |> DateTime.shift_zone!(@timezone)
    day_name = Calendar.strftime(now, "%A")

    {_year, week} =
      :calendar.iso_week_number({now.year, now.month, now.day})

    utc_offset_hours = div(now.utc_offset + now.std_offset, 3600)
    offset_sign = if utc_offset_hours >= 0, do: "+", else: "-"

    user_line =
      cond do
        not dm_session?(session_key) ->
          "\nThis is a shared channel thread — multiple people participate. " <>
            "Each user message is prefixed with its author " <>
            "(\"[from: Full Name <slack_id>]\" — the <slack_id> is a unique " <>
            "identifier, not part of the name; use it to tell apart people " <>
            "who share a name). Address the right person; don't assume " <>
            "there is a single \"the user\"."

        user.name && user.name != "" ->
          "\nUser: #{user.name}"

        true ->
          ""
      end

    """
    [Current Context]
    Now: #{DateTime.to_iso8601(now)} (#{day_name})
    Week: #{week} of #{now.year}
    Timezone: #{@timezone} (#{now.zone_abbr}, UTC#{offset_sign}#{abs(utc_offset_hours)})#{user_line}
    """
    |> String.trim()
  end

  # A DM channel ("D...") is inherently single-user, so it never has the
  # multi-author ambiguity that channel/group threads do.
  defp dm_session?(session_key) do
    case String.split(session_key, ":", parts: 2) do
      ["D" <> _ | _] -> true
      _ -> false
    end
  end

  @impl true
  def handle_cast({:message, message}, state) do
    %{content: content, source: source, reply_to: reply_to} = message
    author_user_id = Map.get(message, :user_id, state.user_id)
    readable_levels = Map.get(message, :readable_levels, state.readable_levels)
    requires_gate = Map.get(message, :requires_gate, false)

    event_ctx = %{
      user_id: author_user_id,
      readable_levels: readable_levels,
      requires_gate: requires_gate,
      session_key: state.session_key,
      meta: %{
        write_access: state.write_access,
        slack_channel_id: Map.get(reply_to || %{}, :channel)
      },
      source: source,
      reply_to: reply_to,
      slack_ts: Map.get(message, :ts)
    }

    # Queue message
    state = %{
      state
      | inbox: state.inbox ++ [{content, event_ctx}],
        participants: MapSet.put(state.participants, author_user_id)
    }

    state =
      if requires_gate do
        # Plain thread reply: debounce so a burst of messages from someone
        # mid-thought gets judged as one batch once they pause, not per message.
        schedule_gate_debounce(state)
      else
        # DM or explicit @mention: unambiguous direct address, process now —
        # this also immediately drains any gated messages still waiting.
        state = cancel_gate_debounce(state)
        send(self(), :loop)
        state
      end

    {:noreply, state}
  end

  def handle_cast({:trigger_idle, event_ctx}, state) do
    Logger.info("Manual idle triggered for session #{state.session_key}")

    # Cancel any pending flush timer
    if state.flush_timer, do: Process.cancel_timer(state.flush_timer)

    # Broadcast one idle event per participant so every author's pending
    # messages get extracted, not just whoever's context happened to trigger
    # the trigger_idle call.
    broadcast_idle_for_participants(state, event_ctx)

    # Terminate - will be restarted on next message
    {:stop, :normal, state}
  end

  # Handle idle from FlushHandler-like behavior (self-subscribes to own topic)
  @impl true
  def handle_info({:flush, event_ctx}, state) do
    Logger.info("Session idle timeout for session #{state.session_key}")

    # Broadcast one idle event per participant (see trigger_idle for why).
    broadcast_idle_for_participants(state, event_ctx)

    # Terminate - will be restarted on next message
    {:stop, :normal, state}
  end

  # Ignore PubSub events we subscribe to for observability/status updates.
  # They can arrive while the server is draining inbox or calling tools.
  def handle_info({:activity, _activity}, state) do
    {:noreply, state}
  end

  # Gate debounce window elapsed with no further gated messages — process
  # whatever's queued now. (If something else already drained the inbox in
  # the meantime, this is a harmless no-op via the empty-inbox :loop clause.)
  def handle_info(:gate_debounce_elapsed, state) do
    send(self(), :loop)
    {:noreply, %{state | gate_debounce_timer: nil}}
  end

  # Loop: nothing to do
  def handle_info(:loop, %{inbox: []} = state) do
    {:noreply, state}
  end

  # Loop: drain inbox, decide whether to respond, start LLM call
  def handle_info(:loop, state) do
    # Check DB health before processing
    unless Repo.healthy?() do
      Logger.error("Agent.Server: database unavailable, cannot process message")
      # Get last event_ctx for error response
      {_content, event_ctx} = List.last(state.inbox)

      Events.broadcast(
        :responding,
        Map.put(event_ctx, :meta, %{
          content: "Issues with database. Need manual intervention."
        })
      )

      {:noreply, %{state | inbox: []}}
    else
      # The gate only applies when every message in this batch is a plain,
      # ungated thread reply — a DM or explicit @mention in the same batch
      # always gets a response.
      gate_applies? = Enum.all?(state.inbox, fn {_content, ctx} -> ctx.requires_gate end)
      prior_transcript = state.transcript
      new_contents = Enum.map(state.inbox, fn {content, _ctx} -> content end)

      # Messages are always persisted + folded into shared history, whether
      # or not the agent decides to actually reply — so the timer resets and
      # future turns have full context either way.
      {messages, event_ctx, state} = drain_inbox(state)
      state = reset_flush_timer(state, event_ctx)

      decision =
        if gate_applies?, do: ResponseGate.decide(prior_transcript, new_contents), else: :respond

      case decision do
        :respond ->
          Events.broadcast(:thinking, event_ctx)

          # Start typing refresher on the triggering author's own topic
          {:ok, refresher_pid} = TypingRefresher.start(event_ctx.user_id, event_ctx)

          send(self(), {:call_llm, event_ctx, 0, refresher_pid})
          {:noreply, %{state | messages: messages}}

        {:react, emoji} ->
          Logger.debug(
            "Agent.Server: response gate chose to react (:#{emoji}:) for session #{state.session_key}"
          )

          Events.broadcast(
            :reacted,
            Map.put(event_ctx, :meta, %{emoji: emoji, ts: event_ctx.slack_ts})
          )

          {:noreply, %{state | messages: messages}}

        {:react_and_respond, emoji} ->
          Logger.debug(
            "Agent.Server: response gate chose to react (:#{emoji}:) and respond for session #{state.session_key}"
          )

          Events.broadcast(
            :reacted,
            Map.put(event_ctx, :meta, %{emoji: emoji, ts: event_ctx.slack_ts})
          )

          Events.broadcast(:thinking, event_ctx)

          {:ok, refresher_pid} = TypingRefresher.start(event_ctx.user_id, event_ctx)

          send(self(), {:call_llm, event_ctx, 0, refresher_pid})
          {:noreply, %{state | messages: messages}}

        :ignore ->
          Logger.debug(
            "Agent.Server: response gate declined to reply for session #{state.session_key}"
          )

          {:noreply, %{state | messages: messages}}
      end
    end
  end

  # LLM call: iteration limit
  def handle_info({:call_llm, _ctx, iter, refresher_pid}, state) when iter >= 50 do
    TypingRefresher.stop(refresher_pid)
    Logger.error("Agent.Server: max tool iterations reached for session #{state.session_key}")
    send(self(), :loop)
    {:noreply, state}
  end

  # LLM call: check for interrupt, then call LLM
  def handle_info({:call_llm, ctx, iter, refresher_pid}, state) do
    if state.inbox != [] do
      # Interrupted by new messages
      TypingRefresher.stop(refresher_pid)
      Logger.info("Agent.Server: interrupted by new message(s) for session #{state.session_key}")
      Events.broadcast(:interrupted, ctx)
      send(self(), :loop)
      {:noreply, state}
    else
      case LLM.generate_text(state.messages,
             tools:
               Manfrod.Tools.definitions(
                 tool_context(ctx.user_id, ctx.readable_levels, state.write_access, msg_ctx(ctx))
               ),
             purpose: :agent
           ) do
        {:ok, response} ->
          handle_llm_response(response, ctx, iter, refresher_pid, state)

        {:error, reason} ->
          TypingRefresher.stop(refresher_pid)
          Logger.error("LLM call failed: #{inspect(reason)}")
          error_text = "Sorry, I encountered an error: #{inspect(reason)}"

          Events.broadcast(:responding, Map.put(ctx, :meta, %{content: error_text}))
          send(self(), :loop)
          {:noreply, state}
      end
    end
  end

  defp message_to_context(%{role: "user", content: content}) do
    ReqLLM.Context.user(content)
  end

  defp message_to_context(%{role: "assistant", content: content}) do
    ReqLLM.Context.assistant(content)
  end

  # Private

  # Drain all messages from inbox, persist to DB, build LLM context
  defp drain_inbox(state) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # Build user messages with note context, persist each to DB under its
    # own author (not a fixed session owner) — a shared thread has messages
    # from several distinct users landing in the same inbox.
    {user_messages, _} =
      Enum.map_reduce(state.inbox, nil, fn {content, event_ctx}, _acc ->
        {:ok, _user_msg} =
          Memory.create_message(event_ctx.user_id, %{
            role: "user",
            content: content,
            session_key: state.session_key,
            received_at: now
          })

        # Retrieve relevant note context (the note graph is a single shared
        # graph gated by access level, not by user, so this is safe to scope
        # to whichever author sent this particular message)
        note_context = get_note_context(event_ctx.user_id, event_ctx.readable_levels, content)

        # Build user message with note context prepended for LLM
        user_content =
          if note_context == "" do
            content
          else
            "[Note context]\n#{note_context}\n\n[User message]\n#{content}"
          end

        {ReqLLM.Context.user(user_content), event_ctx}
      end)

    # Get the last event_ctx for responses
    {_content, last_ctx} = List.last(state.inbox)

    new_contents = Enum.map(state.inbox, fn {content, _ctx} -> content end)
    transcript = Enum.take(state.transcript ++ new_contents, -@transcript_window)

    messages = state.messages ++ user_messages
    state = cancel_gate_debounce(%{state | inbox: [], transcript: transcript})
    {messages, last_ctx, state}
  end

  # Schedule (or restart) the gate debounce timer — fires :gate_debounce_elapsed
  # once no further gated message has arrived for @gate_debounce_delay.
  defp schedule_gate_debounce(state) do
    if state.gate_debounce_timer, do: Process.cancel_timer(state.gate_debounce_timer)
    timer_ref = Process.send_after(self(), :gate_debounce_elapsed, @gate_debounce_delay)
    %{state | gate_debounce_timer: timer_ref}
  end

  defp cancel_gate_debounce(%{gate_debounce_timer: nil} = state), do: state

  defp cancel_gate_debounce(state) do
    Process.cancel_timer(state.gate_debounce_timer)
    %{state | gate_debounce_timer: nil}
  end

  # Reset the idle/flush debounce timer. Called after every processed batch
  # (whether or not the agent actually replied), so a busy multi-author
  # thread where the agent is mostly silently absorbing messages doesn't get
  # torn down mid-conversation.
  defp reset_flush_timer(state, ctx) do
    if state.flush_timer, do: Process.cancel_timer(state.flush_timer)
    timer_ref = Process.send_after(self(), {:flush, ctx}, @flush_delay)
    %{state | flush_timer: timer_ref}
  end

  defp record_transcript(state, line) do
    %{state | transcript: Enum.take(state.transcript ++ [line], -@transcript_window)}
  end

  # Extraction (Manfrod.Memory.Extractor, via FlushHandler) is scoped to a
  # single (user_id, session_key) pair, so a shared multi-author session needs
  # one :idle broadcast per participant to get everyone's pending messages
  # closed out — not just whoever's message happened to be "last".
  defp broadcast_idle_for_participants(state, event_ctx) do
    Enum.each(state.participants, fn participant_id ->
      Events.broadcast(:idle, Map.put(event_ctx, :user_id, participant_id))
    end)
  end

  # Handle LLM response - either tool calls or final response
  defp handle_llm_response(response, ctx, iter, refresher_pid, state) do
    case ReqLLM.Response.finish_reason(response) do
      :tool_calls ->
        # Execute tools and continue conversation
        tool_calls = ReqLLM.Response.tool_calls(response)

        Logger.info(
          "Agent.Server executing #{length(tool_calls)} tool(s) for user #{ctx.user_id}"
        )

        # Extract any narrative text the LLM sent alongside tool calls
        narrative_text = ReqLLM.Response.text(response) || ""

        if narrative_text != "" do
          Events.broadcast(:narrating, Map.put(ctx, :meta, %{text: narrative_text}))
        end

        # Add assistant message with tool calls
        assistant_msg = ReqLLM.Context.assistant(narrative_text, tool_calls: tool_calls)
        messages = state.messages ++ [assistant_msg]

        # Execute each tool and add results
        messages_with_results =
          Enum.reduce(tool_calls, messages, fn tool_call, msgs ->
            action_id = generate_action_id()
            action_name = tool_call.function.name
            args = tool_call.function.arguments

            # Broadcast action started
            Events.broadcast(
              :action_started,
              Map.put(ctx, :meta, %{
                action_id: action_id,
                action: action_name,
                args: args
              })
            )

            # Execute and time the action, on behalf of this turn's actual
            # triggering author (not a fixed session owner)
            {result, duration_ms, success} =
              timed_execute_tool(
                ctx.user_id,
                ctx.readable_levels,
                state.write_access,
                ctx,
                tool_call
              )

            # Broadcast action completed
            Events.broadcast(
              :action_completed,
              Map.put(ctx, :meta, %{
                action_id: action_id,
                action: action_name,
                result: truncate_result(result),
                duration_ms: duration_ms,
                success: success
              })
            )

            tool_result_msg = ReqLLM.Context.tool_result(tool_call.id, action_name, result)
            msgs ++ [tool_result_msg]
          end)

        # Continue the loop
        send(self(), {:call_llm, ctx, iter + 1, refresher_pid})
        {:noreply, %{state | messages: messages_with_results}}

      _other ->
        # Final response - stop typing, persist, broadcast
        TypingRefresher.stop(refresher_pid)

        response_text =
          case ReqLLM.Response.text(response) do
            text when is_binary(text) and text != "" ->
              text

            _ ->
              Logger.warning(
                "Agent.Server got a blank final response for user #{ctx.user_id} " <>
                  "(session #{state.session_key}) after #{iter} iteration(s); " <>
                  "the model ended its turn with tool calls but no closing text"
              )

              "👍"
          end

        # Persist assistant response to DB, attributed to this turn's
        # triggering author (known v1 limitation: in a shared thread, other
        # participants' own extracted conversation won't include this reply).
        # Never let a persistence failure take down the whole session (and
        # with it, any reply to the user) — log and carry on with the
        # in-memory response instead.
        case Memory.create_message(ctx.user_id, %{
               role: "assistant",
               content: response_text,
               session_key: state.session_key,
               received_at: DateTime.utc_now() |> DateTime.truncate(:second)
             }) do
          {:ok, _assistant_msg} ->
            :ok

          {:error, changeset} ->
            Logger.error(
              "Agent.Server failed to persist assistant message for user #{ctx.user_id}: " <>
                inspect(changeset.errors)
            )
        end

        # Add to conversation history
        assistant_msg = ReqLLM.Context.assistant(response_text)
        messages = state.messages ++ [assistant_msg]
        state = record_transcript(state, "Manfrod: #{response_text}")

        # Broadcast response
        Events.broadcast(:responding, Map.put(ctx, :meta, %{content: response_text}))
        Logger.info("Agent.Server broadcast response for user #{ctx.user_id} (#{ctx.source})")

        state = reset_flush_timer(state, ctx)

        # Check for more work
        send(self(), :loop)
        {:noreply, %{state | messages: messages}}
    end
  end

  defp timed_execute_tool(user_id, readable_levels, write_access, ctx, tool_call) do
    start_time = System.monotonic_time(:millisecond)
    {result, success} = execute_tool(user_id, readable_levels, write_access, ctx, tool_call)
    end_time = System.monotonic_time(:millisecond)
    duration_ms = end_time - start_time

    {result, duration_ms, success}
  end

  defp execute_tool(user_id, readable_levels, write_access, ctx, tool_call) do
    tool_name = tool_call.function.name
    args_json = tool_call.function.arguments

    case Jason.decode(args_json) do
      {:ok, args} ->
        # Find and execute the tool
        tool =
          Enum.find(
            Manfrod.Tools.definitions(
              tool_context(user_id, readable_levels, write_access, msg_ctx(ctx))
            ),
            &(&1.name == tool_name)
          )

        if tool do
          case ReqLLM.Tool.execute(tool, args) do
            {:ok, result} -> {result, true}
            {:error, reason} -> {"Tool error: #{inspect(reason)}", false}
          end
        else
          {"Unknown tool: #{tool_name}", false}
        end

      {:error, _} ->
        {"Failed to parse tool arguments", false}
    end
  end

  defp generate_action_id do
    Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
  end

  defp truncate_result(result) when byte_size(result) > 500 do
    String.slice(result, 0, 497) <> "..."
  end

  defp truncate_result(result), do: result

  defp get_note_context(user_id, readable_levels, query) do
    soul = Memory.get_soul(user_id)

    # Get notes linked to soul (workspace notes)
    linked_to_soul =
      if soul do
        Memory.get_node_links(user_id, soul.id)
      else
        []
      end

    # Semantic search for relevant notes based on user query
    {:ok, relevant} = Memory.search(user_id, readable_levels, query, limit: 10)

    # Combine soul + linked + relevant, deduplicated
    nodes =
      ([soul] ++ linked_to_soul ++ relevant)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq_by(& &1.id)

    Memory.build_context(nodes)
  end

  # Identify the inbound Slack message for memory flagging. Only Slack messages
  # (map reply_to with a channel, plus a ts) are flaggable; other sources fall
  # back to direct writes in the mutating tools.
  defp msg_ctx(%{reply_to: %{channel: channel}} = ctx) when is_binary(channel) do
    %{channel: channel, ts: Map.get(ctx, :slack_ts)}
  end

  defp msg_ctx(_ctx), do: %{channel: nil, ts: nil}
end
