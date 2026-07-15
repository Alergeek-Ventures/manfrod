defmodule Manfrod.Agent.Server do
  @moduledoc """
  Per-session Agent GenServer.

  Each session (user + thread) gets its own Agent process with isolated
  conversation history, inbox, and flush timer. Processes are started on
  demand and terminate after an idle timeout (60 minutes), triggering
  memory extraction for that session.

  ## Lifecycle

  1. Started by `Agent.send_message/3` via DynamicSupervisor
  2. Processes messages, calls LLM, broadcasts events on per-user topic
  3. On idle timeout: broadcasts `:idle` (with session_key), terminates normally
  4. Next message for the same session starts a fresh process
  """

  use GenServer, restart: :temporary

  require Logger

  alias Manfrod.Accounts
  alias Manfrod.Agent.Init
  alias Manfrod.Agent.TypingRefresher
  alias Manfrod.Events
  alias Manfrod.LLM
  alias Manfrod.Memory
  alias Manfrod.Memory.Soul
  alias Manfrod.Repo
  alias Manfrod.Skills
  alias Manfrod.Tools.{Escalation, Facts, Notes, Reminders, SkillLoader, Vacation, WebSearch}

  @system_prompt """
  Current date, time, and timezone are provided in the [Current Context] section.
  Use them for scheduling reminders and interpreting relative time references like
  "tomorrow", "next Monday", etc. All reminder times should be in UTC (ISO8601).

  ## Your Capabilities
  - set_reminder: Schedule a one-time reminder for yourself at a specific time
  - list_reminders: See all pending one-time reminders you have scheduled
  - cancel_reminder: Cancel a pending one-time reminder by its job ID
  - create_recurring_reminder: Create a recurring reminder on a cron schedule, linked to a note
  - list_recurring_reminders: See all recurring reminders with their schedules
  - update_recurring_reminder: Modify a recurring reminder's schedule, note, or enabled status
  - delete_recurring_reminder: Remove a recurring reminder and cancel its pending jobs
  - search_notes: Search your zettelkasten for relevant notes
  - get_note: Fetch a specific note by UUID, including linked notes
  - create_note: Add a new note to your slipbox (integrated during retrospection)
  - delete_note: Remove a note and all its links
  - link_notes: Connect two related notes
  - unlink_notes: Disconnect two notes
  - web_search: Search the web for current information using Brave Search
  - get_calendar_events: Fetch events from the user's Google Calendar for a date range
  - get_fact: Look up structured facts (vacations, absences, meetings) by key
  - list_facts: List structured facts by key prefix
  - report_vacation: Flag a planned absence for the background memory to record (memory decides on client visibility)
  - escalate_note: Flag a note to have its visibility widened (applied by the background memory)
  - use_skill: Load the full instructions for one of your Available Skills (see below) when it's relevant to the current message

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

  # Tool definitions live under lib/manfrod/tools/ (one module per domain),
  # each exposing a definitions/N function. user_id/readable_levels/write_access
  # are baked into closures at call time; `msg_ctx` (%{channel, ts}) identifies
  # the inbound Slack message so mutating tools can flag it for the passive
  # memory batch instead of writing directly.
  defp tools(user_id, readable_levels, write_access, msg_ctx) do
    Reminders.definitions(user_id) ++
      Notes.definitions(user_id, readable_levels, write_access, msg_ctx) ++
      WebSearch.definitions() ++
      Manfrod.Tools.Calendar.definitions(user_id) ++
      Facts.definitions(readable_levels) ++
      Vacation.definitions(user_id, msg_ctx) ++
      Escalation.definitions(readable_levels, msg_ctx) ++
      SkillLoader.definitions()
  end

  # Client API

  def start_link({user_id, session_key, write_access, readable_levels}) do
    GenServer.start_link(__MODULE__, {user_id, session_key, write_access, readable_levels},
      name: via(user_id, session_key)
    )
  end

  @doc """
  Registry-based name for per-session Agent processes.
  """
  def via(user_id, session_key) do
    {:via, Registry, {Manfrod.Agent.Registry, {user_id, session_key}}}
  end

  # Server Callbacks

  # 1 minute debounce for testing (change back to 60 for production)
  @flush_delay :timer.minutes(1)

  @impl true
  def init({user_id, session_key, write_access, readable_levels}) do
    system_message = ReqLLM.Context.system(build_system_prompt(user_id))

    # Subscribe to own PubSub topic for FlushHandler-like behavior
    Events.subscribe(user_id)

    # Restore any pending messages from DB (survives crashes/restarts)
    pending = Memory.get_pending_messages(user_id, session_key)
    restored_messages = Enum.map(pending, &message_to_context/1)

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

    Logger.info("Agent.Server started for user #{user_id}, session #{session_key}")

    {:ok,
     %{
       user_id: user_id,
       session_key: session_key,
       write_access: write_access,
       readable_levels: readable_levels,
       messages: messages,
       inbox: [],
       flush_timer: nil
     }}
  end

  defp build_system_prompt(user_id) do
    unless Repo.healthy?() do
      @system_prompt <> Soul.base_prompt()
    else
      context =
        Init.build_system_prompt(user_id,
          include_events: false,
          include_git: false,
          include_samples: false
        )

      soul = Memory.get_soul(user_id)
      user = Accounts.get_user!(user_id)
      current_context = build_current_context(user)

      base =
        if soul do
          context <> "\n\n" <> @system_prompt
        else
          context <> "\n\n" <> @system_prompt <> Soul.base_prompt()
        end

      base <> "\n\n" <> current_context <> skills_catalog()
    end
  end

  defp skills_catalog do
    case Skills.catalog_text() do
      nil -> ""
      text -> "\n\n" <> text
    end
  end

  @timezone "Europe/Warsaw"

  defp build_current_context(user) do
    now = DateTime.utc_now() |> DateTime.shift_zone!(@timezone)
    day_name = Calendar.strftime(now, "%A")

    {_year, week} =
      :calendar.iso_week_number({now.year, now.month, now.day})

    utc_offset_hours = div(now.utc_offset + now.std_offset, 3600)
    offset_sign = if utc_offset_hours >= 0, do: "+", else: "-"

    user_line =
      if user.name && user.name != "" do
        "\nUser: #{user.name}"
      else
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

  @impl true
  def handle_cast({:message, message}, state) do
    %{content: content, source: source, reply_to: reply_to} = message

    event_ctx = %{
      user_id: state.user_id,
      session_key: state.session_key,
      meta: %{
        write_access: state.write_access,
        slack_channel_id: Map.get(reply_to || %{}, :channel)
      },
      source: source,
      reply_to: reply_to,
      slack_ts: Map.get(message, :ts)
    }

    # Queue message and trigger loop
    state = %{state | inbox: state.inbox ++ [{content, event_ctx}]}
    send(self(), :loop)
    {:noreply, state}
  end

  def handle_cast({:trigger_idle, event_ctx}, state) do
    Logger.info("Manual idle triggered for user #{state.user_id}, session #{state.session_key}")

    # Cancel any pending flush timer
    if state.flush_timer, do: Process.cancel_timer(state.flush_timer)

    # Broadcast idle event - triggers extraction
    Events.broadcast(:idle, event_ctx)

    # Terminate - will be restarted on next message
    {:stop, :normal, state}
  end

  # Handle idle from FlushHandler-like behavior (self-subscribes to own topic)
  @impl true
  def handle_info({:flush, event_ctx}, state) do
    Logger.info("Session idle timeout for user #{state.user_id}, session #{state.session_key}")

    # Broadcast idle event
    Events.broadcast(:idle, event_ctx)

    # Terminate - will be restarted on next message
    {:stop, :normal, state}
  end

  # Ignore PubSub events we subscribe to for observability/status updates.
  # They can arrive while the server is draining inbox or calling tools.
  def handle_info({:activity, _activity}, state) do
    {:noreply, state}
  end

  # Loop: nothing to do
  def handle_info(:loop, %{inbox: []} = state) do
    {:noreply, state}
  end

  # Loop: drain inbox, start LLM call
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
      {messages, event_ctx, state} = drain_inbox(state)
      Events.broadcast(:thinking, event_ctx)

      # Start typing refresher
      {:ok, refresher_pid} = TypingRefresher.start(state.user_id, event_ctx)

      send(self(), {:call_llm, event_ctx, 0, refresher_pid})
      {:noreply, %{state | messages: messages}}
    end
  end

  # LLM call: iteration limit
  def handle_info({:call_llm, _ctx, iter, refresher_pid}, state) when iter >= 50 do
    TypingRefresher.stop(refresher_pid)
    Logger.error("Agent.Server: max tool iterations reached for user #{state.user_id}")
    send(self(), :loop)
    {:noreply, state}
  end

  # LLM call: check for interrupt, then call LLM
  def handle_info({:call_llm, ctx, iter, refresher_pid}, state) do
    if state.inbox != [] do
      # Interrupted by new messages
      TypingRefresher.stop(refresher_pid)
      Logger.info("Agent.Server: interrupted by new message(s) for user #{state.user_id}")
      Events.broadcast(:interrupted, ctx)
      send(self(), :loop)
      {:noreply, state}
    else
      case LLM.generate_text(state.messages,
             tools: tools(state.user_id, state.readable_levels, state.write_access, msg_ctx(ctx)),
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

    # Build user messages with note context, persist each to DB
    {user_messages, _} =
      Enum.map_reduce(state.inbox, nil, fn {content, event_ctx}, _acc ->
        # Persist user message to DB
        {:ok, _user_msg} =
          Memory.create_message(state.user_id, %{
            role: "user",
            content: content,
            session_key: state.session_key,
            received_at: now
          })

        # Retrieve relevant note context
        note_context = get_note_context(state.user_id, state.readable_levels, content)

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

    messages = state.messages ++ user_messages
    {messages, last_ctx, %{state | inbox: []}}
  end

  # Handle LLM response - either tool calls or final response
  defp handle_llm_response(response, ctx, iter, refresher_pid, state) do
    case ReqLLM.Response.finish_reason(response) do
      :tool_calls ->
        # Execute tools and continue conversation
        tool_calls = ReqLLM.Response.tool_calls(response)

        Logger.info(
          "Agent.Server executing #{length(tool_calls)} tool(s) for user #{state.user_id}"
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

            # Execute and time the action
            {result, duration_ms, success} =
              timed_execute_tool(
                state.user_id,
                state.readable_levels,
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

        response_text = ReqLLM.Response.text(response) || ""

        # Persist assistant response to DB
        {:ok, _assistant_msg} =
          Memory.create_message(state.user_id, %{
            role: "assistant",
            content: response_text,
            session_key: state.session_key,
            received_at: DateTime.utc_now() |> DateTime.truncate(:second)
          })

        # Add to conversation history
        assistant_msg = ReqLLM.Context.assistant(response_text)
        messages = state.messages ++ [assistant_msg]

        # Broadcast response
        Events.broadcast(:responding, Map.put(ctx, :meta, %{content: response_text}))
        Logger.info("Agent.Server broadcast response for user #{state.user_id} (#{ctx.source})")

        # Debounce flush timer
        if state.flush_timer, do: Process.cancel_timer(state.flush_timer)
        timer_ref = Process.send_after(self(), {:flush, ctx}, @flush_delay)

        # Check for more work
        send(self(), :loop)
        {:noreply, %{state | messages: messages, flush_timer: timer_ref}}
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
            tools(user_id, readable_levels, write_access, msg_ctx(ctx)),
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
