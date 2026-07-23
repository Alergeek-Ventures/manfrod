defmodule ManfrodWeb.DashboardLive do
  @moduledoc """
  Dashboard showing 7-day LLM metrics.

  Displays bar charts for:
  - LLM calls by tier (free vs paid)
  - Token usage (input/output)
  - Retries and fallbacks
  - Messages (sent/received)
  - Tool calls
  """
  use ManfrodWeb, :live_view

  alias Manfrod.Events.Store

  @impl true
  def mount(_params, _session, socket) do
    metrics = Store.aggregate_llm_metrics(7)

    {:ok, assign(socket, metrics: metrics)}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <Layouts.nav current={:dashboard} />
      <div class="min-h-screen bg-zinc-900 text-zinc-200 font-mono text-sm p-6">
        <header class="text-center py-4">
          Last 7 days
        </header>

        <%!-- Summary Cards --%>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
          <.metric_card
            label="Total LLM Calls"
            value={@metrics.totals.free_calls + @metrics.totals.paid_calls}
            sublabel={"#{@metrics.totals.free_calls} free / #{@metrics.totals.paid_calls} paid"}
          />
          <.metric_card
            label="Total Tokens"
            value={format_number(@metrics.totals.input_tokens + @metrics.totals.output_tokens)}
            sublabel={"#{format_number(@metrics.totals.input_tokens)} in / #{format_number(@metrics.totals.output_tokens)} out"}
          />
          <.metric_card
            label="Cached Input"
            value={format_number(@metrics.totals.cached_tokens)}
            sublabel={cache_hit_rate(@metrics.totals)}
          />
          <.metric_card
            label="Messages"
            value={@metrics.totals.messages_received + @metrics.totals.messages_sent}
            sublabel={"#{@metrics.totals.messages_received} received / #{@metrics.totals.messages_sent} sent"}
          />
          <.metric_card
            label="Retries / Fallbacks"
            value={@metrics.totals.retries + @metrics.totals.fallbacks}
            sublabel={"#{@metrics.totals.retries} retries / #{@metrics.totals.fallbacks} fallbacks"}
          />
        </div>

        <%!-- Charts Grid --%>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <%!-- LLM Calls Chart --%>
          <.chart_card title="LLM Calls by Tier">
            <.bar_chart
              data={@metrics.daily}
              bars={[
                %{key: :free_calls, color: "bg-green-500", label: "Free"},
                %{key: :paid_calls, color: "bg-amber-500", label: "Paid"}
              ]}
            />
          </.chart_card>

          <%!-- Token Usage Chart --%>
          <.chart_card title="Token Usage">
            <.bar_chart
              data={@metrics.daily}
              bars={[
                %{key: :input_tokens, color: "bg-blue-500", label: "Input"},
                %{key: :output_tokens, color: "bg-purple-500", label: "Output"}
              ]}
              format={:tokens}
            />
          </.chart_card>

          <%!-- Prompt Cache Chart --%>
          <.chart_card title="Prompt Cache">
            <.bar_chart
              data={@metrics.daily}
              bars={[
                %{key: :cached_tokens, color: "bg-emerald-500", label: "Cache read"},
                %{key: :cache_creation_tokens, color: "bg-lime-500", label: "Cache write"}
              ]}
              format={:tokens}
            />
          </.chart_card>

          <%!-- Messages Chart --%>
          <.chart_card title="Messages">
            <.bar_chart
              data={@metrics.daily}
              bars={[
                %{key: :messages_received, color: "bg-cyan-500", label: "Received"},
                %{key: :messages_sent, color: "bg-teal-500", label: "Sent"}
              ]}
            />
          </.chart_card>

          <%!-- Retries & Fallbacks Chart --%>
          <.chart_card title="Retries & Fallbacks">
            <.bar_chart
              data={@metrics.daily}
              bars={[
                %{key: :retries, color: "bg-amber-400", label: "Retries"},
                %{key: :fallbacks, color: "bg-orange-500", label: "Fallbacks"}
              ]}
            />
          </.chart_card>

          <%!-- Tool Calls Chart --%>
          <.chart_card title="Tool Calls">
            <.bar_chart
              data={@metrics.daily}
              bars={[
                %{key: :tool_calls, color: "bg-purple-400", label: "Tools"}
              ]}
            />
          </.chart_card>
        </div>
      </div>
    </Layouts.app>
    """
  end

  # Components

  defp metric_card(assigns) do
    ~H"""
    <div class="bg-zinc-800 border border-zinc-700 rounded-lg p-4">
      <div class="text-zinc-500 text-xs uppercase tracking-wide mb-1"><%= @label %></div>
      <div class="text-2xl font-bold text-zinc-100"><%= @value %></div>
      <div class="text-zinc-500 text-xs mt-1"><%= @sublabel %></div>
    </div>
    """
  end

  defp chart_card(assigns) do
    ~H"""
    <div class="bg-zinc-800 border border-zinc-700 rounded-lg p-4">
      <h3 class="text-zinc-300 font-semibold mb-4"><%= @title %></h3>
      <%= render_slot(@inner_block) %>
    </div>
    """
  end

  defp bar_chart(assigns) do
    assigns = assign_new(assigns, :format, fn -> :number end)

    # Calculate max value for scaling
    max_value =
      assigns.data
      |> Enum.flat_map(fn day ->
        Enum.map(assigns.bars, fn bar -> Map.get(day, bar.key, 0) end)
      end)
      |> Enum.max(fn -> 1 end)
      |> max(1)

    assigns = assign(assigns, :max_value, max_value)

    ~H"""
    <div class="space-y-2">
      <%!-- Legend --%>
      <div class="flex gap-4 mb-3 text-xs">
        <%= for bar <- @bars do %>
          <div class="flex items-center gap-1">
            <div class={"w-3 h-3 rounded #{bar.color}"}></div>
            <span class="text-zinc-400"><%= bar.label %></span>
          </div>
        <% end %>
      </div>

      <%!-- Bars --%>
      <%= for day <- @data do %>
        <div class="flex items-center gap-2">
          <div class="w-16 text-xs text-zinc-500 tabular-nums">
            <%= format_date(day.date) %>
          </div>
          <div class="flex-1 flex gap-1 h-5">
            <%= for bar <- @bars do %>
              <% value = Map.get(day, bar.key, 0) %>
              <% width_pct = if @max_value > 0, do: value / @max_value * 100, else: 0 %>
              <div
                class={"h-full rounded #{bar.color} transition-all duration-300"}
                style={"width: #{width_pct}%"}
                title={"#{bar.label}: #{format_value(value, @format)}"}
              >
              </div>
            <% end %>
          </div>
          <div class="w-20 text-xs text-zinc-500 text-right tabular-nums">
            <%= format_day_total(day, @bars, @format) %>
          </div>
        </div>
      <% end %>
    </div>
    """
  end

  # Helpers

  defp format_date(date) do
    Calendar.strftime(date, "%m/%d")
  end

  defp format_number(n) when n >= 1_000_000 do
    "#{Float.round(n / 1_000_000, 1)}M"
  end

  defp format_number(n) when n >= 1_000 do
    "#{Float.round(n / 1_000, 1)}K"
  end

  defp format_number(n), do: to_string(n)

  defp format_value(value, :tokens), do: format_number(value)
  defp format_value(value, _), do: to_string(value)

  defp cache_hit_rate(%{input_tokens: input, cached_tokens: cached}) when input > 0 do
    "#{Float.round(cached / input * 100, 1)}% of input"
  end

  defp cache_hit_rate(_totals), do: "no input yet"

  defp format_day_total(day, bars, format) do
    total = Enum.sum(Enum.map(bars, fn bar -> Map.get(day, bar.key, 0) end))
    format_value(total, format)
  end
end
