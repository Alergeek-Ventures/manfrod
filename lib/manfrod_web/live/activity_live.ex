defmodule ManfrodWeb.ActivityLive do
  @moduledoc """
  Live activity feed for full assistant observability.

  Shows all events in real-time: messages, actions, logs, memory ops.
  Streams events terminal-style. Keeps ~200 events in memory.

  Filters:
  - Log levels: warning+ by default, toggle to show info/debug
  - Event types: all shown by default

  Supports query params for viewing specific time ranges:
  - `from` - ISO8601 datetime to filter events from
  - `to` - ISO8601 datetime to filter events until
  - `source` - filter by source (e.g., "retrospector")

  When filtered, live updates are disabled and a context banner is shown.
  """
  use ManfrodWeb, :live_view

  alias Manfrod.Events
  alias Manfrod.Events.Activity
  alias Manfrod.Events.Store

  @max_events 200

  @impl true
  def mount(_params, _session, socket) do
    socket =
      socket
      |> assign(events: [])
      |> assign(show_all_logs: false)
      |> assign(expanded: MapSet.new())
      |> assign(filter: nil)

    {:ok, socket}
  end

  @impl true
  def handle_params(params, _uri, socket) do
    # Parse filter params
    filter = parse_filter_params(params)

    # Only subscribe to live events if not filtered
    if connected?(socket) and is_nil(filter) do
      Events.subscribe_global()
    end

    # Load events based on filter
    events = load_events(filter, socket.assigns.show_all_logs)

    socket =
      socket
      |> assign(filter: filter)
      |> assign(events: events)

    {:noreply, socket}
  end

  defp parse_filter_params(params) do
    from_str = Map.get(params, "from")
    to_str = Map.get(params, "to")
    source = Map.get(params, "source")

    from_dt = parse_datetime(from_str)
    to_dt = parse_datetime(to_str)

    if from_dt || to_dt || source do
      %{from: from_dt, to: to_dt, source: source}
    else
      nil
    end
  end

  defp parse_datetime(nil), do: nil

  defp parse_datetime(str) do
    case DateTime.from_iso8601(str) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp load_events(nil, show_all_logs) do
    Store.list_recent_filtered(@max_events, include_all_logs: show_all_logs)
  end

  defp load_events(filter, show_all_logs) do
    opts = [
      include_all_logs: show_all_logs,
      from: filter.from,
      to: filter.to,
      source: filter.source
    ]

    Store.list_recent_filtered(@max_events, opts)
  end

  @impl true
  def handle_info({:activity, %Activity{} = activity}, socket) do
    # Only process live events if not filtered
    if socket.assigns.filter do
      {:noreply, socket}
    else
      # Filter incoming logs based on current setting
      should_show =
        if activity.type == :log do
          socket.assigns.show_all_logs or
            activity.meta[:level] in [:warning, :error]
        else
          true
        end

      socket =
        if should_show do
          events =
            [activity | socket.assigns.events]
            |> Enum.take(@max_events)

          assign(socket, events: events)
        else
          socket
        end

      {:noreply, socket}
    end
  end

  @impl true
  def handle_event("toggle_all_logs", _, socket) do
    show_all_logs = !socket.assigns.show_all_logs

    # Reload events with new filter
    events = load_events(socket.assigns.filter, show_all_logs)

    {:noreply, assign(socket, show_all_logs: show_all_logs, events: events)}
  end

  def handle_event("toggle_expand", %{"id" => id}, socket) do
    expanded =
      if MapSet.member?(socket.assigns.expanded, id) do
        MapSet.delete(socket.assigns.expanded, id)
      else
        MapSet.put(socket.assigns.expanded, id)
      end

    {:noreply, assign(socket, expanded: expanded)}
  end

  def handle_event("clear_filter", _, socket) do
    {:noreply, push_patch(socket, to: "/")}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash}>
      <Layouts.nav current={:activity} />
      <div class="h-screen flex flex-col font-mono text-sm bg-zinc-900 text-zinc-200">
        <%!-- Context Banner (when filtered) --%>
        <%= if @filter do %>
          <.filter_banner filter={@filter} />
        <% end %>

        <%!-- Navbar --%>
        <header class="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-700 px-4 py-3">
          <div class="flex justify-end items-center">
            <div class="flex items-center gap-6">
              <label class="flex items-center gap-2 text-zinc-500 cursor-pointer text-xs hover:text-zinc-300 transition-colors">
                <input
                  type="checkbox"
                  checked={@show_all_logs}
                  phx-click="toggle_all_logs"
                  class="cursor-pointer accent-blue-400"
                />
                <span>show all logs</span>
              </label>
              <span class="text-zinc-600 text-xs">
                <%= length(@events) %> events
              </span>
            </div>
          </div>
        </header>

        <%!-- Event List with Grid --%>
        <div
          class="flex-1 overflow-y-auto grid grid-cols-[max-content_max-content_max-content_1fr] gap-x-4"
          id="activity-log"
        >
          <%!-- Column Headers (sticky, spans all columns) --%>
          <div class="sticky top-0 z-10 col-span-full grid grid-cols-subgrid bg-zinc-900 border-b border-zinc-700 py-2 px-4 text-xs text-zinc-500 uppercase tracking-wider">
            <span>Time</span>
            <span>Type</span>
            <span>Source</span>
            <span>Details</span>
          </div>

          <%!-- Event Rows --%>
          <%= for event <- @events do %>
            <div
              class={[
                "col-span-full grid grid-cols-subgrid cursor-pointer transition-colors border-b border-zinc-800 py-1 px-4",
                row_bg_class(event)
              ]}
              id={"event-#{event.id}"}
              phx-click="toggle_expand"
              phx-value-id={event.id}
            >
              <span class="text-zinc-500 tabular-nums"><%= format_time(event.timestamp) %></span>
              <span class={["font-semibold", type_color_class(event)]}><%= format_type(event) %></span>
              <span class="text-cyan-400"><%= event.source || "-" %></span>
              <span class="text-zinc-400 truncate">
                <%= format_detail(event) %>
              </span>
            </div>
            <%= if MapSet.member?(@expanded, event.id) do %>
              <div class="col-span-full py-3 px-4 border-b border-zinc-800 bg-zinc-950/50">
                <pre class="whitespace-pre-wrap break-all text-xs text-zinc-400 max-h-72 overflow-y-auto leading-relaxed pl-4"><%= format_expanded(event) %></pre>
              </div>
            <% end %>
          <% end %>
        </div>
      </div>
    </Layouts.app>
    """
  end

  # Filter banner component
  defp filter_banner(assigns) do
    ~H"""
    <div class="bg-blue-950/50 border-b border-blue-800 px-4 py-3">
      <div class="flex items-center justify-between max-w-4xl mx-auto">
        <div class="flex items-center gap-3">
          <span class="text-zinc-300 text-sm">
            <%= format_filter_description(@filter) %>
          </span>
        </div>
        <button
          phx-click="clear_filter"
          class="text-zinc-400 hover:text-zinc-200 text-xs flex items-center gap-1"
        >
          ✕ Clear filter
        </button>
      </div>
    </div>
    """
  end

  defp format_filter_description(filter) do
    parts = []

    parts =
      if filter.source do
        agent_name = String.capitalize(filter.source)
        parts ++ ["#{agent_name} run"]
      else
        parts
      end

    parts =
      if filter.from do
        parts ++ ["from #{format_datetime(filter.from)}"]
      else
        parts
      end

    parts =
      if filter.to do
        parts ++ ["to #{format_datetime(filter.to)}"]
      else
        parts
      end

    Enum.join(parts, " ")
  end

  defp format_datetime(dt) do
    Calendar.strftime(dt, "%b %d, %H:%M:%S")
  end

  # Row background classes (base + hover)
  defp row_bg_class(%Activity{type: :log, meta: %{level: :error}}) do
    "bg-red-950/30 hover:bg-red-950/50"
  end

  defp row_bg_class(%Activity{type: :log, meta: %{level: :warning}}) do
    "bg-amber-950/20 hover:bg-amber-950/40"
  end

  defp row_bg_class(_event) do
    "hover:bg-zinc-800"
  end

  # Type color classes
  defp type_color_class(%Activity{type: :log, meta: %{level: :error}}), do: "text-red-500"
  defp type_color_class(%Activity{type: :log, meta: %{level: :warning}}), do: "text-amber-500"
  defp type_color_class(%Activity{type: :log, meta: %{level: :info}}), do: "text-cyan-400"
  defp type_color_class(%Activity{type: :log}), do: "text-zinc-500"
  defp type_color_class(%Activity{type: :thinking}), do: "text-yellow-400"
  defp type_color_class(%Activity{type: :narrating}), do: "text-yellow-400"
  defp type_color_class(%Activity{type: :responding}), do: "text-green-400"
  defp type_color_class(%Activity{type: :idle}), do: "text-zinc-500"
  defp type_color_class(%Activity{type: :message_received}), do: "text-cyan-400"
  defp type_color_class(%Activity{type: :action_started}), do: "text-purple-400"

  defp type_color_class(%Activity{type: :action_completed, meta: %{success: true}}),
    do: "text-green-400"

  defp type_color_class(%Activity{type: :action_completed, meta: %{success: false}}),
    do: "text-red-500"

  defp type_color_class(%Activity{type: :action_completed}), do: "text-purple-400"

  defp type_color_class(%Activity{type: type})
       when type in [
              :memory_searched,
              :memory_node_created,
              :memory_link_created,
              :memory_node_processed
            ],
       do: "text-teal-400"

  defp type_color_class(%Activity{type: type})
       when type in [
              :extraction_started,
              :extraction_completed,
              :retrospection_started,
              :retrospection_completed
            ],
       do: "text-teal-400"

  defp type_color_class(%Activity{type: type})
       when type in [:extraction_failed, :retrospection_failed],
       do: "text-red-500"

  # LLM events
  defp type_color_class(%Activity{type: :llm_call_started}), do: "text-indigo-400"
  defp type_color_class(%Activity{type: :llm_call_succeeded}), do: "text-green-400"
  defp type_color_class(%Activity{type: :llm_call_failed}), do: "text-red-500"
  defp type_color_class(%Activity{type: :llm_retry}), do: "text-amber-400"
  defp type_color_class(%Activity{type: :llm_fallback}), do: "text-orange-400"

  defp type_color_class(_), do: "text-zinc-400"

  defp format_time(%DateTime{} = dt) do
    Calendar.strftime(dt, "%H:%M:%S")
  end

  # Format type display
  defp format_type(%Activity{type: :log, meta: %{level: level}}) do
    String.upcase("#{level}")
  end

  defp format_type(%Activity{type: :message_received}), do: "MESSAGE"
  defp format_type(%Activity{type: :action_started}), do: "ACTION:START"
  defp format_type(%Activity{type: :action_completed}), do: "ACTION:DONE"
  defp format_type(%Activity{type: :thinking}), do: "THINKING"
  defp format_type(%Activity{type: :narrating}), do: "NARRATING"
  defp format_type(%Activity{type: :responding}), do: "RESPONDING"
  defp format_type(%Activity{type: :idle}), do: "IDLE"
  defp format_type(%Activity{type: :memory_searched}), do: "MEMORY:SEARCH"
  defp format_type(%Activity{type: :memory_node_created}), do: "MEMORY:CREATE"
  defp format_type(%Activity{type: :memory_link_created}), do: "MEMORY:LINK"
  defp format_type(%Activity{type: :memory_node_processed}), do: "MEMORY:PROCESS"
  defp format_type(%Activity{type: :extraction_started}), do: "EXTRACT:START"
  defp format_type(%Activity{type: :extraction_completed}), do: "EXTRACT:DONE"
  defp format_type(%Activity{type: :extraction_failed}), do: "EXTRACT:FAIL"
  defp format_type(%Activity{type: :retrospection_started}), do: "RETROSPECT:START"
  defp format_type(%Activity{type: :retrospection_completed}), do: "RETROSPECT:DONE"
  defp format_type(%Activity{type: :retrospection_failed}), do: "RETROSPECT:FAIL"
  # LLM events
  defp format_type(%Activity{type: :llm_call_started}), do: "LLM:START"
  defp format_type(%Activity{type: :llm_call_succeeded}), do: "LLM:OK"
  defp format_type(%Activity{type: :llm_call_failed}), do: "LLM:FAIL"
  defp format_type(%Activity{type: :llm_retry}), do: "LLM:RETRY"
  defp format_type(%Activity{type: :llm_fallback}), do: "LLM:FALLBACK"
  defp format_type(%Activity{type: type}), do: String.upcase(to_string(type))

  # Format detail (one-line summary)
  defp format_detail(%Activity{type: :message_received, meta: %{content: content}}) do
    truncate(content, 100)
  end

  defp format_detail(%Activity{type: :action_started, meta: %{action: action, args: args}}) do
    "#{action} #{truncate(args, 80)}"
  end

  defp format_detail(%Activity{type: :action_completed, meta: meta}) do
    duration = Map.get(meta, :duration_ms, 0)
    result_preview = truncate(Map.get(meta, :result, ""), 60)
    "#{duration}ms #{result_preview}"
  end

  defp format_detail(%Activity{type: :log, meta: %{message: message}}) do
    truncate(message, 120)
  end

  defp format_detail(%Activity{type: :narrating, meta: %{text: text}}) do
    truncate(text, 120)
  end

  defp format_detail(%Activity{type: :responding, meta: %{content: content}}) do
    truncate(content, 120)
  end

  defp format_detail(%Activity{type: :idle}), do: "conversation timeout"

  # LLM events
  defp format_detail(%Activity{type: :llm_call_started, meta: meta}) do
    tier_badge = if meta[:tier] == :paid, do: "[PAID] ", else: ""
    "#{tier_badge}#{meta[:provider]}/#{meta[:model]} (#{meta[:purpose]})"
  end

  defp format_detail(%Activity{type: :llm_call_succeeded, meta: meta}) do
    tokens = format_tokens(meta[:input_tokens], meta[:output_tokens])
    tier_badge = if meta[:tier] == :paid, do: "[PAID] ", else: ""
    "#{tier_badge}#{meta[:provider]}/#{meta[:model]} #{meta[:latency_ms]}ms #{tokens}"
  end

  defp format_detail(%Activity{type: :llm_call_failed, meta: meta}) do
    "#{meta[:provider]}/#{meta[:model]} attempt #{meta[:attempt]}: #{meta[:error]}"
  end

  defp format_detail(%Activity{type: :llm_retry, meta: meta}) do
    "#{meta[:provider]}/#{meta[:model]} retry ##{meta[:attempt]} in #{meta[:delay_ms]}ms"
  end

  defp format_detail(%Activity{type: :llm_fallback, meta: meta}) do
    "#{meta[:from_provider]}/#{meta[:from_model]} → #{meta[:to_provider]}/#{meta[:to_model]}"
  end

  defp format_detail(%Activity{meta: meta}) when map_size(meta) > 0 do
    inspect(meta, limit: 5)
  end

  defp format_detail(_), do: ""

  # Format expanded content
  defp format_expanded(%Activity{type: :action_started, meta: meta}) do
    """
    Action: #{meta[:action]}
    Args: #{format_json(meta[:args])}
    """
  end

  defp format_expanded(%Activity{type: :action_completed, meta: meta}) do
    base = """
    Duration: #{meta[:duration_ms]}ms
    Success: #{meta[:success]}
    Result:
    #{meta[:result]}
    """

    base
  end

  defp format_expanded(%Activity{type: :log, meta: meta}) do
    parts = [
      "Message: #{meta[:message]}",
      if(meta[:module], do: "Module: #{inspect(meta[:module])}"),
      if(meta[:function], do: "Function: #{meta[:function]}"),
      if(meta[:file], do: "File: #{meta[:file]}:#{meta[:line]}"),
      if(meta[:crash_reason], do: "\nCrash Reason: #{meta[:crash_reason]}"),
      if(meta[:stacktrace], do: "\nStacktrace:\n#{meta[:stacktrace]}")
    ]

    parts
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
  end

  defp format_expanded(%Activity{type: :message_received, meta: meta}) do
    """
    Content: #{meta[:content]}
    From: #{meta[:from_id]}
    Chat: #{meta[:chat_id]}
    """
  end

  defp format_expanded(%Activity{type: :responding, meta: %{content: content}}) do
    content
  end

  defp format_expanded(%Activity{type: :narrating, meta: %{text: text}}) do
    text
  end

  # LLM events
  defp format_expanded(%Activity{type: :llm_call_succeeded, meta: meta}) do
    """
    Provider: #{meta[:provider]}
    Model: #{meta[:model]}
    Tier: #{meta[:tier]}
    Purpose: #{meta[:purpose]}
    Latency: #{meta[:latency_ms]}ms
    Input tokens: #{meta[:input_tokens] || "N/A"}
    Output tokens: #{meta[:output_tokens] || "N/A"}
    Total tokens: #{meta[:total_tokens] || "N/A"}
    """
  end

  defp format_expanded(%Activity{type: :llm_call_failed, meta: meta}) do
    """
    Provider: #{meta[:provider]}
    Model: #{meta[:model]}
    Tier: #{meta[:tier]}
    Purpose: #{meta[:purpose]}
    Attempt: #{meta[:attempt]}
    Latency: #{meta[:latency_ms]}ms
    Error: #{meta[:error]}
    """
  end

  defp format_expanded(%Activity{type: :llm_fallback, meta: meta}) do
    """
    From: #{meta[:from_provider]}/#{meta[:from_model]}
    To: #{meta[:to_provider]}/#{meta[:to_model]}
    Purpose: #{meta[:purpose]}
    Reason: #{meta[:reason]}
    """
  end

  defp format_expanded(%Activity{type: :llm_call_started, meta: meta}) do
    """
    Provider: #{meta[:provider]}
    Model: #{meta[:model]}
    Tier: #{meta[:tier]}
    Purpose: #{meta[:purpose]}
    Attempt: #{meta[:attempt]}
    """
  end

  defp format_expanded(%Activity{type: :llm_retry, meta: meta}) do
    """
    Provider: #{meta[:provider]}
    Model: #{meta[:model]}
    Tier: #{meta[:tier]}
    Purpose: #{meta[:purpose]}
    Attempt: #{meta[:attempt]}
    Delay: #{meta[:delay_ms]}ms
    Reason: #{meta[:reason]}
    """
  end

  # Extraction events
  defp format_expanded(%Activity{type: :extraction_started, meta: meta}) do
    "Messages to process: #{meta[:message_count]}"
  end

  defp format_expanded(%Activity{type: :extraction_completed, meta: meta}) do
    """
    Conversation ID: #{meta[:conversation_id]}
    Nodes created: #{meta[:node_count]}
    Summary: #{meta[:summary_preview]}
    """
  end

  defp format_expanded(%Activity{type: :extraction_failed, meta: meta}) do
    "Reason: #{meta[:reason]}"
  end

  # Retrospection events
  defp format_expanded(%Activity{type: :retrospection_started, meta: meta}) do
    """
    Slipbox nodes: #{meta[:slipbox_count]}
    Review sample: #{meta[:review_count]}
    """
  end

  defp format_expanded(%Activity{type: :retrospection_completed, meta: meta}) do
    """
    Nodes processed: #{meta[:nodes_processed]}
    Links created: #{meta[:links_created]}
    Insights created: #{meta[:insights_created]}
    Nodes deleted: #{meta[:nodes_deleted]}
    Links deleted: #{meta[:links_deleted]}
    """
  end

  defp format_expanded(%Activity{type: :retrospection_failed, meta: meta}) do
    "Reason: #{meta[:reason]}"
  end

  # Memory events
  defp format_expanded(%Activity{type: :memory_searched, meta: meta}) do
    query = meta[:query] || meta[:query_preview] || "?"
    expanded_queries = meta[:expanded_queries] || []
    rerank_scores = meta[:rerank_scores] || []
    stats = meta[:stats] || %{}

    # Format expanded queries section
    queries_section =
      case expanded_queries do
        queries when is_list(queries) and length(queries) > 0 ->
          formatted =
            queries
            |> Enum.with_index(1)
            |> Enum.map(fn {q, i} -> "  #{i}. #{q}" end)
            |> Enum.join("\n")

          "\nExpanded queries:\n#{formatted}"

        count when is_integer(count) ->
          "\nExpanded queries: #{count}"

        _ ->
          ""
      end

    # Format pipeline stats section
    pipeline_section =
      if map_size(stats) > 0 do
        threshold = stats[:relevance_threshold] || "?"
        filtered_out = (stats[:merged] || 0) - (stats[:filtered] || 0)
        rerank_status = if stats[:rerank_ran], do: "yes", else: "no"
        expand_status = if stats[:expand_query_enabled], do: "yes", else: "no"

        """

        Pipeline:
          Query expansion: #{expand_status}
          Vector search: #{stats[:vector] || 0} results
          BM25 search: #{stats[:bm25] || 0} results
          RRF merged: #{stats[:merged] || 0} unique
          Reranked: #{rerank_status} (#{stats[:reranked] || 0} candidates)
          Filtered (threshold #{threshold}): #{stats[:filtered] || 0} passed, #{filtered_out} dropped
          Final (with links): #{stats[:final] || 0} results
        """
      else
        # Fallback for old format
        "\nResults: #{meta[:result_count] || 0}"
      end

    # Format rerank scores section
    rerank_section =
      if is_list(rerank_scores) and length(rerank_scores) > 0 do
        formatted =
          rerank_scores
          |> Enum.map(fn score_info ->
            score = score_info[:score] || score_info["score"] || 0
            preview = score_info[:content_preview] || score_info["content_preview"] || ""

            "  #{Float.round(score, 3) |> :erlang.float_to_binary(decimals: 3)}  \"#{preview}...\""
          end)
          |> Enum.join("\n")

        "\nRerank scores:\n#{formatted}"
      else
        if stats[:rerank_ran] == false and stats[:rerank_enabled] do
          "\nRerank scores: skipped (< 2 candidates)"
        else
          ""
        end
      end

    "Query: #{query}#{queries_section}#{pipeline_section}#{rerank_section}"
  end

  defp format_expanded(%Activity{type: :memory_node_created, meta: meta}) do
    """
    Node ID: #{meta[:node_id]}
    Content: #{meta[:content_preview]}
    """
  end

  defp format_expanded(%Activity{type: :memory_link_created, meta: meta}) do
    "Link: #{meta[:node_a_id]} <-> #{meta[:node_b_id]}"
  end

  defp format_expanded(%Activity{type: :memory_node_processed, meta: meta}) do
    "Node ID: #{meta[:node_id]}"
  end

  defp format_expanded(%Activity{meta: meta}) do
    inspect(meta, pretty: true, limit: :infinity)
  end

  defp format_json(json) when is_binary(json) do
    case Jason.decode(json) do
      {:ok, decoded} -> Jason.encode!(decoded, pretty: true)
      _ -> json
    end
  end

  defp format_json(other), do: inspect(other, pretty: true)

  defp format_tokens(nil, nil), do: ""
  defp format_tokens(input, output), do: "(#{input || 0}→#{output || 0} tok)"

  defp truncate(nil, _max), do: ""

  defp truncate(str, max) when is_binary(str) and byte_size(str) > max do
    String.slice(str, 0, max - 3) <> "..."
  end

  defp truncate(str, _max) when is_binary(str), do: str
  defp truncate(other, max), do: truncate(inspect(other), max)
end
