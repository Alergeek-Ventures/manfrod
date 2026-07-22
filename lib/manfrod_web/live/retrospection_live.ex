defmodule ManfrodWeb.RetrospectionLive do
  @moduledoc """
  Retrospection run viewer with structured conversation display.

  Two-panel layout:
  - Left: run list (last 7 days of Retrospector runs)
  - Right: structured conversation view for the selected run

  The conversation view groups events by iteration into "turns", showing
  the agent's thinking (narrative), tool calls (collapsible cards), and
  memory mutations inline.

  Live-updates via PubSub when runs start, progress, or complete.
  """
  use ManfrodWeb, :live_view

  alias Manfrod.Events
  alias Manfrod.Events.Activity
  alias Manfrod.Events.Store

  @impl true
  def mount(_params, _session, socket) do
    if connected?(socket), do: Events.subscribe_global()

    runs = Store.list_agent_runs(days: 7)

    socket =
      socket
      |> assign(runs: runs)
      |> assign(selected_run: nil)
      |> assign(events: [])
      |> assign(turns: [])
      |> assign(expanded: MapSet.new())

    {:ok, socket}
  end

  @impl true
  def handle_params(params, _uri, socket) do
    selected_run =
      case Map.get(params, "run") do
        nil ->
          nil

        run_ts ->
          case DateTime.from_iso8601(run_ts) do
            {:ok, dt, _offset} ->
              Enum.find(socket.assigns.runs, fn r ->
                DateTime.compare(r.started_at, dt) == :eq
              end)

            _ ->
              nil
          end
      end

    {events, turns} =
      if selected_run do
        evts = Store.list_run_events(selected_run.started_at, selected_run.ended_at)
        {evts, group_into_turns(evts)}
      else
        {[], []}
      end

    socket =
      socket
      |> assign(selected_run: selected_run)
      |> assign(events: events)
      |> assign(turns: turns)

    {:noreply, socket}
  end

  # -- PubSub handlers --------------------------------------------------------

  @impl true
  def handle_info({:activity, %Activity{type: :retrospection_started} = activity}, socket) do
    # A new run started — rebuild the run list
    runs = Store.list_agent_runs(days: 7)
    socket = assign(socket, runs: runs)

    # If we're viewing an in-progress run and this is for the same time window, refresh
    socket = maybe_refresh_selected(socket, activity)
    {:noreply, socket}
  end

  def handle_info(
        {:activity, %Activity{type: type} = activity},
        socket
      )
      when type in [:retrospection_completed, :retrospection_failed] do
    # A run finished — rebuild the run list
    runs = Store.list_agent_runs(days: 7)
    socket = assign(socket, runs: runs)

    # If we're viewing this run, refresh events
    socket = maybe_refresh_selected(socket, activity)
    {:noreply, socket}
  end

  def handle_info({:activity, %Activity{source: :retrospector} = activity}, socket) do
    # Tool call / narrating event from retrospector — append if viewing this run
    socket = maybe_append_event(socket, activity)
    {:noreply, socket}
  end

  def handle_info({:activity, %Activity{source: :memory} = activity}, socket) do
    # Memory mutation event — append if viewing the current run
    socket = maybe_append_event(socket, activity)
    {:noreply, socket}
  end

  def handle_info({:activity, _activity}, socket) do
    {:noreply, socket}
  end

  defp maybe_refresh_selected(socket, _activity) do
    case socket.assigns.selected_run do
      nil ->
        socket

      run ->
        # Re-fetch events for the selected run
        runs = socket.assigns.runs
        # Find the updated run (might have ended_at now)
        updated_run =
          Enum.find(runs, fn r ->
            DateTime.compare(r.started_at, run.started_at) == :eq
          end) || run

        evts = Store.list_run_events(updated_run.started_at, updated_run.ended_at)

        socket
        |> assign(selected_run: updated_run)
        |> assign(events: evts)
        |> assign(turns: group_into_turns(evts))
    end
  end

  defp maybe_append_event(socket, activity) do
    case socket.assigns.selected_run do
      nil ->
        socket

      run ->
        # Only append if this event falls within the run's time window
        # and the run is still in progress (or just completed)
        if run.outcome == :running or
             ((run.ended_at &&
                 DateTime.compare(activity.timestamp, run.started_at) in [:gt, :eq]) and
                DateTime.compare(activity.timestamp, run.ended_at) in [:lt, :eq]) do
          events = socket.assigns.events ++ [activity]

          socket
          |> assign(events: events)
          |> assign(turns: group_into_turns(events))
        else
          socket
        end
    end
  end

  # -- Events ------------------------------------------------------------------

  @impl true
  def handle_event("toggle_expand", %{"id" => id}, socket) do
    expanded =
      if MapSet.member?(socket.assigns.expanded, id) do
        MapSet.delete(socket.assigns.expanded, id)
      else
        MapSet.put(socket.assigns.expanded, id)
      end

    {:noreply, assign(socket, expanded: expanded)}
  end

  # -- Turn grouping -----------------------------------------------------------

  defp group_into_turns(events) do
    events
    |> Enum.group_by(fn event ->
      # Group by iteration number from meta, or -1 for events without it
      event.meta[:iteration] || -1
    end)
    |> Enum.sort_by(fn {iteration, _events} -> iteration end)
    |> Enum.map(fn {iteration, turn_events} ->
      narrative =
        turn_events
        |> Enum.find(fn e -> e.type == :narrating end)

      tool_calls = extract_tool_calls(turn_events)

      memory_events =
        turn_events
        |> Enum.filter(fn e ->
          e.type in [
            :memory_node_created,
            :memory_node_updated,
            :memory_node_deleted,
            :memory_link_created,
            :memory_link_deleted,
            :memory_node_processed,
            :memory_searched
          ]
        end)

      %{
        iteration: iteration,
        narrative: narrative,
        tool_calls: tool_calls,
        memory_events: memory_events,
        final: narrative && narrative.meta[:final] == true
      }
    end)
    |> Enum.reject(fn turn ->
      # Drop empty turns (iteration -1 with no useful content)
      is_nil(turn.narrative) and turn.tool_calls == [] and turn.memory_events == []
    end)
  end

  defp extract_tool_calls(events) do
    # Pair action_started with action_completed by action_id
    starts =
      events
      |> Enum.filter(&(&1.type == :action_started))
      |> Map.new(fn e -> {e.meta[:action_id], e} end)

    completions =
      events
      |> Enum.filter(&(&1.type == :action_completed))
      |> Map.new(fn e -> {e.meta[:action_id], e} end)

    # Build paired tool calls, ordered by timestamp
    starts
    |> Enum.map(fn {action_id, start_event} ->
      completion = Map.get(completions, action_id)

      %{
        action_id: action_id,
        action: start_event.meta[:action],
        args: start_event.meta[:args],
        result: completion && completion.meta[:result],
        duration_ms: completion && completion.meta[:duration_ms],
        success: completion && completion.meta[:success],
        timestamp: start_event.timestamp
      }
    end)
    |> Enum.sort_by(& &1.timestamp, DateTime)
  end

  # -- Render ------------------------------------------------------------------

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <Layouts.nav current={:retrospection} />
      <div class="h-screen flex font-mono text-sm bg-zinc-900 text-zinc-200">
        <%!-- Left panel: Run list --%>
        <div class="w-72 flex-shrink-0 border-r border-zinc-700 overflow-y-auto">
          <header class="sticky top-0 z-10 bg-zinc-950 border-b border-zinc-700 px-4 py-3">
            <h2 class="text-xs text-zinc-500 uppercase tracking-wider">Retrospection Runs</h2>
          </header>

          <%= if @runs == [] do %>
            <div class="text-center text-zinc-500 py-12 px-4 text-xs">
              No runs in the last 7 days.
            </div>
          <% else %>
            <div class="divide-y divide-zinc-800">
              <%= for run <- @runs do %>
                <.run_card
                  run={run}
                  selected={@selected_run && @selected_run.started_at == run.started_at}
                />
              <% end %>
            </div>
          <% end %>
        </div>

        <%!-- Right panel: Conversation view --%>
        <div class="flex-1 overflow-y-auto">
          <%= if @selected_run do %>
            <.conversation_view
              run={@selected_run}
              turns={@turns}
              expanded={@expanded}
            />
          <% else %>
            <div class="flex items-center justify-center h-full text-zinc-500 text-xs">
              Select a run to view its conversation.
            </div>
          <% end %>
        </div>
      </div>
    </Layouts.app>
    """
  end

  # -- Run card component ------------------------------------------------------

  defp run_card(assigns) do
    ~H"""
    <.link
      patch={"/retrospection?run=#{DateTime.to_iso8601(@run.started_at)}"}
      class={[
        "block px-4 py-3 transition-colors cursor-pointer",
        @selected && "bg-zinc-800 border-l-2 border-blue-400",
        !@selected && "hover:bg-zinc-800/50 border-l-2 border-transparent"
      ]}
    >
      <div class="flex items-center justify-between gap-2">
        <span class="text-zinc-400 text-xs">
          <%= format_run_datetime(@run.started_at) %>
        </span>
        <.outcome_badge outcome={@run.outcome} duration_ms={@run.duration_ms} />
      </div>
      <div class="mt-1">
        <.kind_badge kind={@run.kind} />
      </div>
      <div class="mt-1 text-zinc-500 text-xs truncate">
        <%= @run.intent %>
      </div>
      <%= if @run.outcome == :success and map_size(@run.stats) > 0 do %>
        <div class="mt-1.5 flex flex-wrap gap-2 text-xs text-zinc-600">
          <%= for {label, value} <- format_run_stats(@run.stats) do %>
            <span><%= label %>: <span class="text-zinc-500"><%= value %></span></span>
          <% end %>
        </div>
      <% end %>
    </.link>
    """
  end

  defp kind_badge(assigns) do
    {text, class} =
      case assigns.kind do
        :slipbox_drain -> {"Slipbox drain", "text-blue-400 bg-blue-900/20 border-blue-800"}
        :graph_review -> {"Graph review", "text-purple-400 bg-purple-900/20 border-purple-800"}
        nil -> {"Unknown", "text-zinc-500 bg-zinc-800/40 border-zinc-700"}
      end

    assigns = assign(assigns, text: text, class: class)

    ~H"""
    <span class={"inline-block text-[10px] px-1.5 py-0.5 rounded border #{@class}"}>
      <%= @text %>
    </span>
    """
  end

  defp outcome_badge(assigns) do
    {symbol, text, class} =
      case assigns.outcome do
        :success ->
          {"✓", format_duration(assigns.duration_ms), "text-green-400"}

        :failure ->
          {"✗", "Failed", "text-red-400"}

        :running ->
          {"⟳", "Running...", "text-amber-400 animate-pulse"}
      end

    assigns = assign(assigns, symbol: symbol, text: text, class: class)

    ~H"""
    <span class={"flex items-center gap-1 text-xs #{@class}"}>
      <span><%= @symbol %></span>
      <span><%= @text %></span>
    </span>
    """
  end

  # -- Conversation view -------------------------------------------------------

  defp conversation_view(assigns) do
    ~H"""
    <div class="max-w-4xl mx-auto px-6 py-4">
      <%!-- Run header --%>
      <header class="mb-6 pb-4 border-b border-zinc-800">
        <div class="flex items-center gap-3">
          <span class="text-teal-400 text-xs font-semibold px-2 py-0.5 rounded bg-teal-900/30 border border-teal-800">
            Retrospector
          </span>
          <.kind_badge kind={@run.kind} />
          <span class="text-zinc-400 text-xs">
            <%= format_run_datetime(@run.started_at) %>
          </span>
          <.outcome_badge outcome={@run.outcome} duration_ms={@run.duration_ms} />
        </div>
        <div class="mt-2 text-zinc-400 text-sm">
          <%= @run.intent %>
        </div>
      </header>

      <%!-- Turns --%>
      <div class="space-y-4">
        <%= for turn <- @turns do %>
          <.turn_block turn={turn} expanded={@expanded} />
        <% end %>
      </div>

      <%!-- Summary footer --%>
      <%= if @run.outcome == :success and map_size(@run.stats) > 0 do %>
        <.summary_footer stats={@run.stats} />
      <% end %>

      <%= if @run.outcome == :failure do %>
        <div class="mt-6 p-4 bg-red-950/30 border border-red-800 rounded-lg text-red-400 text-xs">
          Run failed.
        </div>
      <% end %>
    </div>
    """
  end

  # -- Turn block --------------------------------------------------------------

  defp turn_block(assigns) do
    ~H"""
    <div class={[
      "border border-zinc-800 rounded-lg overflow-hidden",
      @turn.final && "border-teal-800/50"
    ]}>
      <%!-- Turn header --%>
      <div class="flex items-center gap-2 px-4 py-2 bg-zinc-850 border-b border-zinc-800 bg-zinc-800/30">
        <span class="text-zinc-600 text-xs">
          <%= if @turn.final, do: "Final", else: "Iteration #{@turn.iteration}" %>
        </span>
        <%= if length(@turn.tool_calls) > 0 do %>
          <span class="text-zinc-600 text-xs">
            · <%= length(@turn.tool_calls) %> tool call<%= if length(@turn.tool_calls) != 1, do: "s" %>
          </span>
        <% end %>
      </div>

      <div class="px-4 py-3 space-y-3">
        <%!-- Narrative bubble --%>
        <%= if @turn.narrative do %>
          <.narrative_bubble text={@turn.narrative.meta[:text]} final={@turn.final} />
        <% end %>

        <%!-- Tool call cards --%>
        <%= for tc <- @turn.tool_calls do %>
          <.tool_card tool_call={tc} expanded={MapSet.member?(@expanded, tc.action_id)} />
        <% end %>
      </div>
    </div>
    """
  end

  # -- Narrative bubble --------------------------------------------------------

  defp narrative_bubble(assigns) do
    ~H"""
    <div class={[
      "text-sm leading-relaxed whitespace-pre-wrap",
      @final && "text-teal-300/80 italic",
      !@final && "text-zinc-400 italic"
    ]}>
      <%= @text %>
    </div>
    """
  end

  # -- Tool call card ----------------------------------------------------------

  defp tool_card(assigns) do
    border_class = tool_border_class(assigns.tool_call.action)
    action_label = format_action_name(assigns.tool_call.action)
    assigns = assign(assigns, border_class: border_class, action_label: action_label)

    ~H"""
    <div class={"rounded border #{@border_class} overflow-hidden"}>
      <%!-- Card header (always visible, clickable to expand) --%>
      <div
        class="flex items-center justify-between px-3 py-1.5 bg-zinc-800/50 cursor-pointer hover:bg-zinc-800/80 transition-colors"
        phx-click="toggle_expand"
        phx-value-id={@tool_call.action_id}
      >
        <div class="flex items-center gap-2">
          <span class={"text-xs font-medium #{tool_text_class(@tool_call.action)}"}>
            <%= @action_label %>
          </span>
          <%= if @tool_call.success == false do %>
            <span class="text-red-400 text-xs">✗</span>
          <% end %>
          <span class="text-zinc-600 text-xs">
            <%= tool_call_summary(@tool_call) %>
          </span>
        </div>
        <div class="flex items-center gap-2">
          <%= if @tool_call.duration_ms do %>
            <span class="text-zinc-600 text-xs tabular-nums">
              <%= format_duration(@tool_call.duration_ms) %>
            </span>
          <% end %>
          <span class="text-zinc-600 text-xs"><%= if @expanded, do: "▾", else: "▸" %></span>
        </div>
      </div>

      <%!-- Expanded detail --%>
      <%= if @expanded do %>
        <div class="px-3 py-2 text-xs space-y-2 border-t border-zinc-800/50">
          <%!-- Args --%>
          <%= if @tool_call.args do %>
            <div>
              <span class="text-zinc-500">Args:</span>
              <pre class="mt-1 text-zinc-400 whitespace-pre-wrap break-all leading-relaxed"><%= format_args(@tool_call.args) %></pre>
            </div>
          <% end %>

          <%!-- Result --%>
          <%= if @tool_call.result do %>
            <div>
              <span class="text-zinc-500">Result:</span>
              <pre class="mt-1 text-zinc-400 whitespace-pre-wrap break-all leading-relaxed max-h-48 overflow-y-auto"><%= @tool_call.result %></pre>
            </div>
          <% end %>
        </div>
      <% end %>
    </div>
    """
  end

  # -- Summary footer ----------------------------------------------------------

  defp summary_footer(assigns) do
    ~H"""
    <div class="mt-6 p-4 bg-teal-950/20 border border-teal-800/40 rounded-lg">
      <h3 class="text-teal-400 text-xs font-semibold uppercase tracking-wider mb-2">Summary</h3>
      <div class="grid grid-cols-3 gap-3 text-xs">
        <.stat_item label="Processed" value={@stats[:nodes_processed] || @stats["nodes_processed"] || 0} />
        <.stat_item label="Updated" value={@stats[:nodes_updated] || @stats["nodes_updated"] || 0} />
        <.stat_item label="Links created" value={@stats[:links_created] || @stats["links_created"] || 0} />
        <.stat_item label="Insights" value={@stats[:insights_created] || @stats["insights_created"] || 0} />
        <.stat_item label="Nodes deleted" value={@stats[:nodes_deleted] || @stats["nodes_deleted"] || 0} />
        <.stat_item label="Links deleted" value={@stats[:links_deleted] || @stats["links_deleted"] || 0} />
      </div>
    </div>
    """
  end

  defp stat_item(assigns) do
    ~H"""
    <div>
      <span class="text-zinc-500"><%= @label %>:</span>
      <span class="text-zinc-300 ml-1"><%= @value %></span>
    </div>
    """
  end

  # -- Formatting helpers ------------------------------------------------------

  defp format_run_datetime(dt) do
    Calendar.strftime(dt, "%b %d, %H:%M")
  end

  defp format_duration(nil), do: "..."
  defp format_duration(ms) when ms < 1000, do: "#{ms}ms"
  defp format_duration(ms) when ms < 60_000, do: "#{div(ms, 1000)}s"

  defp format_duration(ms) do
    minutes = div(ms, 60_000)
    seconds = rem(div(ms, 1000), 60)
    "#{minutes}m #{seconds}s"
  end

  defp format_run_stats(stats) do
    [
      {"processed", stats[:nodes_processed] || stats["nodes_processed"]},
      {"linked", stats[:links_created] || stats["links_created"]},
      {"insights", stats[:insights_created] || stats["insights_created"]},
      {"deleted", stats[:nodes_deleted] || stats["nodes_deleted"]}
    ]
    |> Enum.reject(fn {_k, v} -> is_nil(v) or v == 0 end)
  end

  defp format_action_name(name) when is_binary(name), do: name
  defp format_action_name(name) when is_atom(name), do: to_string(name)
  defp format_action_name(_), do: "unknown"

  defp format_args(args) when is_binary(args) do
    case Jason.decode(args) do
      {:ok, decoded} -> Jason.encode!(decoded, pretty: true)
      _ -> args
    end
  end

  defp format_args(args) when is_map(args) do
    Jason.encode!(args, pretty: true)
  end

  defp format_args(args), do: inspect(args, pretty: true)

  # Brief summary shown in the collapsed card header
  defp tool_call_summary(%{action: "search", args: args}) do
    case safe_decode_arg(args, "query") do
      nil -> ""
      query -> "\"#{truncate(query, 40)}\""
    end
  end

  defp tool_call_summary(%{action: "get_node", args: args}) do
    safe_decode_arg(args, "node_id") || ""
  end

  defp tool_call_summary(%{action: "create_node", args: args}) do
    case safe_decode_arg(args, "content") do
      nil -> ""
      content -> "\"#{truncate(content, 40)}\""
    end
  end

  defp tool_call_summary(%{action: "update_node", args: args}) do
    safe_decode_arg(args, "node_id") || ""
  end

  defp tool_call_summary(%{action: "create_link", args: args}) do
    a = safe_decode_arg(args, "node_a_id")
    b = safe_decode_arg(args, "node_b_id")
    if a && b, do: "#{truncate(a, 8)}..↔#{truncate(b, 8)}..", else: ""
  end

  defp tool_call_summary(%{action: "delete_node", args: args}) do
    safe_decode_arg(args, "node_id") || ""
  end

  defp tool_call_summary(%{action: "delete_link", args: args}) do
    safe_decode_arg(args, "link_id") || ""
  end

  defp tool_call_summary(%{action: "list_links", args: args}) do
    safe_decode_arg(args, "node_id") || ""
  end

  defp tool_call_summary(%{action: "mark_processed", args: args}) do
    safe_decode_arg(args, "node_id") || ""
  end

  defp tool_call_summary(%{action: "graph_stats"}), do: ""

  defp tool_call_summary(%{action: "web_search", args: args}) do
    case safe_decode_arg(args, "query") do
      nil -> ""
      query -> "\"#{truncate(query, 40)}\""
    end
  end

  defp tool_call_summary(_), do: ""

  defp safe_decode_arg(args, key) when is_binary(args) do
    case Jason.decode(args) do
      {:ok, map} when is_map(map) -> Map.get(map, key)
      _ -> nil
    end
  end

  defp safe_decode_arg(args, key) when is_map(args), do: Map.get(args, key)
  defp safe_decode_arg(_, _), do: nil

  # Tool card styling by category
  defp tool_border_class("search"), do: "border-zinc-700"
  defp tool_border_class("get_node"), do: "border-zinc-700"
  defp tool_border_class("list_links"), do: "border-zinc-700"
  defp tool_border_class("graph_stats"), do: "border-zinc-700"
  defp tool_border_class("create_node"), do: "border-teal-700/60"
  defp tool_border_class("create_link"), do: "border-teal-700/60"
  defp tool_border_class("update_node"), do: "border-blue-700/60"
  defp tool_border_class("mark_processed"), do: "border-blue-700/60"
  defp tool_border_class("delete_node"), do: "border-red-700/40"
  defp tool_border_class("delete_link"), do: "border-red-700/40"
  defp tool_border_class("web_search"), do: "border-indigo-700/60"
  defp tool_border_class(_), do: "border-zinc-700"

  defp tool_text_class("search"), do: "text-zinc-400"
  defp tool_text_class("get_node"), do: "text-zinc-400"
  defp tool_text_class("list_links"), do: "text-zinc-400"
  defp tool_text_class("graph_stats"), do: "text-zinc-400"
  defp tool_text_class("create_node"), do: "text-teal-400"
  defp tool_text_class("create_link"), do: "text-teal-400"
  defp tool_text_class("update_node"), do: "text-blue-400"
  defp tool_text_class("mark_processed"), do: "text-blue-400"
  defp tool_text_class("delete_node"), do: "text-red-400"
  defp tool_text_class("delete_link"), do: "text-red-400"
  defp tool_text_class("web_search"), do: "text-indigo-400"
  defp tool_text_class(_), do: "text-zinc-400"

  defp truncate(str, max) when byte_size(str) > max do
    String.slice(str, 0, max - 3) <> "..."
  end

  defp truncate(str, _max), do: str
end
