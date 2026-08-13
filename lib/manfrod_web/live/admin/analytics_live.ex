defmodule ManfrodWeb.Admin.AnalyticsLive do
  @moduledoc """
  Usage and adoption analytics for the admin panel.

  Answers three questions: who in the company actually uses the bot, what it
  costs, and how the model switch (DeepSeek V4 Flash to GPT-5.6 Luna) changed
  both. Reads exclusively from the daily rollup tables, so the range selector
  can look back further than the 7-day raw event retention.
  """
  use ManfrodWeb, :live_view

  alias Manfrod.Analytics

  @ranges [7, 30, 90]
  @default_range 30

  # Color follows the model, not its rank in the table — filtering or a new
  # model appearing must never repaint the others. Slots 1-3 of the validated
  # dark categorical palette (all-pairs CVD ΔE 9.4, normal-vision 20.9).
  @model_colors %{
    "deepseek/deepseek-v4-flash" => "#3987e5",
    "openai/gpt-5.6-luna" => "#d95926",
    "llama-3.1-8b-instant" => "#199e70",
    "moonshotai/kimi-k2.5" => "#c98500"
  }
  @fallback_color "#9085e9"

  @impl true
  def mount(_params, _session, socket) do
    {:ok, load(socket, @default_range)}
  end

  @impl true
  def handle_params(%{"days" => days}, _uri, socket) do
    case Integer.parse(days) do
      {n, ""} when n in @ranges -> {:noreply, load(socket, n)}
      _ -> {:noreply, socket}
    end
  end

  def handle_params(_params, _uri, socket), do: {:noreply, socket}

  @impl true
  def handle_event("set_range", %{"days" => days}, socket) do
    {:noreply, push_patch(socket, to: ~p"/admin/analytics?days=#{days}")}
  end

  defp load(socket, days) do
    assign(socket, days: days, ranges: @ranges, data: Analytics.overview(days))
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <Layouts.nav current={:analytics} current_scope={@current_scope} />
      <div class="min-h-screen bg-zinc-900 text-zinc-200 font-mono text-sm p-6">
        <%!-- Filters: one row above the charts --%>
        <header class="flex flex-wrap items-baseline justify-between gap-4 mb-6">
          <div>
            <h1 class="text-zinc-100 text-base">usage &amp; adoption</h1>
            <p class="text-zinc-500 text-xs mt-1">
              <%= format_date(elem(@data.range, 0)) %> – <%= format_date(elem(@data.range, 1)) %>
            </p>
          </div>
          <div class="flex gap-1">
            <button
              :for={range <- @ranges}
              phx-click="set_range"
              phx-value-days={range}
              class={[
                "px-3 py-1 rounded border transition-colors",
                if(range == @days,
                  do: "border-zinc-500 bg-zinc-800 text-zinc-100",
                  else: "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                )
              ]}
            >
              <%= range %>d
            </button>
          </div>
        </header>

        <%!-- Headline numbers: no plot, so no hover layer --%>
        <div class="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mb-8">
          <.stat
            label="Spend"
            value={"$#{money(@data.summary.cost_usd)}"}
            sub={delta_label(@data.summary.cost_usd, @data.summary.previous_cost_usd, "vs prev")}
          />
          <.stat
            label="Projected / month"
            value={"$#{money(@data.summary.projected_monthly_cost)}"}
            sub={"at the last #{@days}d rate"}
          />
          <.stat
            label="Active people"
            value={@data.summary.active_users}
            sub={"of #{@data.summary.total_people} provisioned"}
          />
          <.stat
            label="Reach"
            value={"#{@data.adoption.reach}%"}
            sub={"#{@data.adoption.never_used} never used it"}
          />
          <.stat
            label="Cache savings"
            value={"$#{money(@data.summary.cache_savings_usd)}"}
            sub={"#{@data.summary.cache_hit_rate}% of input cached"}
          />
          <.stat
            label="LLM calls"
            value={format_number(@data.summary.calls)}
            sub={"#{@data.summary.failed_calls} failed / #{@data.summary.retries} retries"}
          />
          <.stat
            label="Satisfaction"
            value={satisfaction_value(@data.feedback)}
            sub={satisfaction_sub(@data.feedback)}
          />
        </div>

        <%!-- Adoption --%>
        <h2 class="text-zinc-400 text-xs uppercase tracking-widest mb-3">adoption</h2>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          <.card title="Active people per day" hint="distinct people who interacted">
            <.bars
              rows={
                Enum.map(@data.daily, fn d ->
                  %{label: format_date(d.date), value: d.active_users, display: d.active_users}
                end)
              }
              color="#3987e5"
            />
          </.card>

          <.card title="Conversation volume" hint="messages the bot sent per day">
            <.bars
              rows={
                Enum.map(@data.daily, fn d ->
                  %{
                    label: format_date(d.date),
                    value: d.messages_sent,
                    display: format_number(d.messages_sent)
                  }
                end)
              }
              color="#199e70"
            />
          </.card>
        </div>

        <%!-- Per-person table --%>
        <.card title="Per person" hint={"last #{@days} days, most active first"} class="mb-8">
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="text-zinc-500 border-b border-zinc-700">
                <tr>
                  <th class="text-left font-normal py-2 pr-4">person</th>
                  <th class="text-right font-normal py-2 px-2">msgs in</th>
                  <th class="text-right font-normal py-2 px-2">replies</th>
                  <th class="text-right font-normal py-2 px-2">sessions</th>
                  <th class="text-right font-normal py-2 px-2">tools</th>
                  <th class="text-right font-normal py-2 px-2">notes</th>
                  <th class="text-right font-normal py-2 px-2">active days</th>
                  <th class="text-right font-normal py-2 px-2">calls</th>
                  <th class="text-right font-normal py-2 pl-2">cost</th>
                </tr>
              </thead>
              <tbody>
                <tr :for={u <- @data.by_user} class="border-b border-zinc-800/60">
                  <td class="py-2 pr-4 text-zinc-200 whitespace-nowrap">
                    <%= u.name %>
                    <span :if={u.system} class="text-zinc-600 ml-1">(system)</span>
                  </td>
                  <td class="text-right px-2 tabular-nums"><%= u.messages_received %></td>
                  <td class="text-right px-2 tabular-nums"><%= u.messages_sent %></td>
                  <td class="text-right px-2 tabular-nums"><%= u.sessions %></td>
                  <td class="text-right px-2 tabular-nums"><%= u.tool_calls %></td>
                  <td class="text-right px-2 tabular-nums"><%= u.notes_created %></td>
                  <td class="text-right px-2 tabular-nums"><%= u.active_days %>/<%= @days %></td>
                  <td class="text-right px-2 tabular-nums"><%= u.calls %></td>
                  <td class="text-right pl-2 tabular-nums">
                    <span :if={u.attributed?}>$<%= money(u.cost_usd) %></span>
                    <span :if={not u.attributed?} class="text-zinc-600" title="LLM calls were not
                    attributed to a user before this was instrumented">–</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p :if={Enum.any?(@data.by_user, &(not &1.attributed?))} class="text-zinc-600 text-xs mt-3">
            "–" means those calls predate per-user cost attribution; totals above still include them.
          </p>
        </.card>

        <%!-- Tools --%>
        <h2 class="text-zinc-400 text-xs uppercase tracking-widest mb-3">tools</h2>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          <.card
            title="Everyday use"
            hint="reads, listings, memory fetches — routine calls on the way to an answer"
          >
            <p :if={@data.by_tool.everyday == []} class="text-zinc-500 text-xs py-2">
              No tool calls in this window.
            </p>
            <.bars
              :if={@data.by_tool.everyday != []}
              rows={
                Enum.map(@data.by_tool.everyday, fn t ->
                  %{label: t.tool, value: t.calls, display: format_number(t.calls)}
                end)
              }
              color="#3987e5"
              label_width="w-36"
            />
          </.card>

          <.card
            title="User intent"
            hint="an action the user asked for by name — booking a desk, opening the door, a reminder"
          >
            <p :if={@data.by_tool.intent == []} class="text-zinc-500 text-xs py-2">
              No intent-driven tool calls in this window.
            </p>
            <.bars
              :if={@data.by_tool.intent != []}
              rows={
                Enum.map(@data.by_tool.intent, fn t ->
                  %{label: t.tool, value: t.calls, display: format_number(t.calls)}
                end)
              }
              color="#d95926"
              label_width="w-36"
            />
          </.card>
        </div>

        <%!-- Negative feedback --%>
        <h2 class="text-zinc-400 text-xs uppercase tracking-widest mb-3">feedback</h2>
        <.card
          title="Answers rated bad"
          hint={"last #{@days} days, newest first"}
          class="mb-8"
        >
          <p :if={@data.negative_feedback == []} class="text-zinc-500 text-xs py-2">
            <%= if @data.feedback.total == 0 do %>
              Nobody has rated an answer in this window.
            <% else %>
              <%= @data.feedback.good %> positive ratings, none negative.
            <% end %>
          </p>

          <div :if={@data.negative_feedback != []} class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="text-zinc-500 border-b border-zinc-700">
                <tr>
                  <th class="text-left font-normal py-2 pr-4">when</th>
                  <th class="text-left font-normal py-2 pr-4">who</th>
                  <th class="text-left font-normal py-2 pr-4">where</th>
                  <th class="text-left font-normal py-2 pl-2">message</th>
                </tr>
              </thead>
              <tbody>
                <tr :for={f <- @data.negative_feedback} class="border-b border-zinc-800/60">
                  <td class="py-2 pr-4 text-zinc-400 whitespace-nowrap tabular-nums">
                    <%= format_datetime(f.inserted_at) %>
                  </td>
                  <td class="py-2 pr-4 text-zinc-200 whitespace-nowrap">
                    <%= rater(f) %>
                  </td>
                  <td class="py-2 pr-4 text-zinc-400 whitespace-nowrap">
                    <%= where(f) %>
                  </td>
                  <td class="py-2 pl-2">
                    <a
                      :if={f.permalink}
                      href={f.permalink}
                      target="_blank"
                      rel="noopener"
                      class="text-blue-400 hover:underline"
                    >
                      open in Slack
                    </a>
                    <span
                      :if={is_nil(f.permalink)}
                      class="text-zinc-600"
                      title="The message was gone, or the link could not be resolved, when the rating came in"
                    >
                      no link
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </.card>

        <%!-- Models --%>
        <h2 class="text-zinc-400 text-xs uppercase tracking-widest mb-3">models</h2>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          <.card title="Daily spend by model" hint="the switchover, in dollars">
            <.legend items={
              Enum.map(@data.model_timeline.models, &%{label: model_label(&1), color: model_color(&1)})
            } />
            <.stacked
              series={@data.model_timeline.series}
              models={@data.model_timeline.models}
              max={max_daily_cost(@data.model_timeline.series)}
            />
          </.card>

          <.card title="Cost per model" hint="whole window">
            <div class="space-y-4">
              <div :for={m <- @data.by_model} class="space-y-1">
                <div class="flex items-baseline justify-between gap-2">
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={"background-color: #{model_color(m.model)}"}
                    >
                    </span>
                    <span class="text-zinc-200 truncate"><%= m.label %></span>
                    <span :if={m.free} class="text-zinc-600 text-xs shrink-0">free</span>
                    <span :if={m.unpriced} class="text-amber-500 text-xs shrink-0">no pricing</span>
                  </div>
                  <span class="text-zinc-100 tabular-nums shrink-0">$<%= money(m.cost_usd) %></span>
                </div>
                <div class="text-zinc-500 text-xs flex flex-wrap gap-x-3">
                  <span><%= format_number(m.calls) %> calls</span>
                  <span><%= format_number(m.input_tokens) %> in / <%= format_number(m.output_tokens) %> out</span>
                  <span><%= m.cache_hit_rate %>% cached</span>
                  <span><%= m.avg_latency_ms %>ms avg</span>
                  <span><%= format_date(m.first_seen) %>–<%= format_date(m.last_seen) %></span>
                </div>
              </div>
            </div>
            <p
              :if={Enum.any?(@data.by_model, & &1.unpriced)}
              class="text-amber-500/80 text-xs mt-4"
            >
              A model with no pricing entry is costed at $0 — add it to
              <code>Manfrod.Pricing</code>
              so spend isn't understated.
            </p>
          </.card>
        </div>

        <%!-- Where the money goes --%>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
          <.card title="Cost by purpose" hint="which subsystem spends the budget">
            <.bars
              rows={
                Enum.map(@data.by_purpose, fn p ->
                  %{
                    label: p.purpose,
                    value: Decimal.to_float(p.cost_usd),
                    display: "$" <> money(p.cost_usd)
                  }
                end)
              }
              color="#d95926"
              label_width="w-28"
            />
          </.card>

          <.card title="Pricing in effect" hint="USD per million tokens">
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead class="text-zinc-500 border-b border-zinc-700">
                  <tr>
                    <th class="text-left font-normal py-2 pr-4">model</th>
                    <th class="text-right font-normal py-2 px-2">input</th>
                    <th class="text-right font-normal py-2 px-2">output</th>
                    <th class="text-right font-normal py-2 px-2">cached in</th>
                    <th class="text-right font-normal py-2 pl-2">cache write</th>
                  </tr>
                </thead>
                <tbody>
                  <tr :for={p <- @data.pricing} class="border-b border-zinc-800/60">
                    <td class="py-2 pr-4 text-zinc-300 whitespace-nowrap"><%= p.label %></td>
                    <td class="text-right px-2 tabular-nums"><%= rate(p.input_per_mtok) %></td>
                    <td class="text-right px-2 tabular-nums"><%= rate(p.output_per_mtok) %></td>
                    <td class="text-right px-2 tabular-nums"><%= rate(p.cached_input_per_mtok) %></td>
                    <td class="text-right pl-2 tabular-nums"><%= cache_write_rate(p) %></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </.card>
        </div>

        <%!-- Weekly adoption trend --%>
        <.card title="Weekly" hint="active people and volume per week">
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="text-zinc-500 border-b border-zinc-700">
                <tr>
                  <th class="text-left font-normal py-2 pr-4">week of</th>
                  <th class="text-right font-normal py-2 px-2">active people</th>
                  <th class="text-right font-normal py-2 px-2">sessions</th>
                  <th class="text-right font-normal py-2 pl-2">messages</th>
                </tr>
              </thead>
              <tbody>
                <tr :for={w <- @data.adoption.weekly} class="border-b border-zinc-800/60">
                  <td class="py-2 pr-4 tabular-nums"><%= format_date(w.week) %></td>
                  <td class="text-right px-2 tabular-nums"><%= w.active_users %></td>
                  <td class="text-right px-2 tabular-nums"><%= w.sessions %></td>
                  <td class="text-right pl-2 tabular-nums"><%= w.messages %></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-500 mt-4">
            <span>avg <%= @data.adoption.avg_daily_active %> people/day</span>
            <span>stickiness <%= @data.adoption.stickiness %> (daily/window)</span>
            <span>$<%= money(@data.summary.cost_per_active_user) %> per active person</span>
          </div>
        </.card>
      </div>
    </Layouts.app>
    """
  end

  # Components

  attr :label, :string, required: true
  attr :value, :any, required: true
  attr :sub, :string, default: nil

  defp stat(assigns) do
    ~H"""
    <div class="bg-zinc-800 border border-zinc-700 rounded-lg p-3">
      <div class="text-zinc-500 text-xs uppercase tracking-wide"><%= @label %></div>
      <div class="text-xl text-zinc-100 mt-1 tabular-nums"><%= @value %></div>
      <div :if={@sub} class="text-zinc-500 text-xs mt-1"><%= @sub %></div>
    </div>
    """
  end

  attr :title, :string, required: true
  attr :hint, :string, default: nil
  attr :class, :string, default: nil
  slot :inner_block, required: true

  defp card(assigns) do
    ~H"""
    <div class={["bg-zinc-800 border border-zinc-700 rounded-lg p-4", @class]}>
      <div class="mb-4">
        <h3 class="text-zinc-300"><%= @title %></h3>
        <p :if={@hint} class="text-zinc-500 text-xs mt-0.5"><%= @hint %></p>
      </div>
      <%= render_slot(@inner_block) %>
    </div>
    """
  end

  attr :items, :list, required: true

  defp legend(assigns) do
    ~H"""
    <div class="flex flex-wrap gap-x-4 gap-y-1 mb-3 text-xs">
      <div :for={item <- @items} class="flex items-center gap-1.5">
        <span class="w-2.5 h-2.5 rounded-sm" style={"background-color: #{item.color}"}></span>
        <span class="text-zinc-400"><%= item.label %></span>
      </div>
    </div>
    """
  end

  # Single-series horizontal bars. One series, so the card title names it and
  # no legend box is needed; each row carries its own value label.
  attr :rows, :list, required: true
  attr :color, :string, required: true
  attr :label_width, :string, default: "w-16"

  defp bars(assigns) do
    max = assigns.rows |> Enum.map(& &1.value) |> Enum.max(fn -> 0 end) |> max(1)
    assigns = assign(assigns, :max, max)

    ~H"""
    <div class="space-y-1">
      <div :for={row <- @rows} class="flex items-center gap-2" title={"#{row.label}: #{row.display}"}>
        <div class={["text-xs text-zinc-500 tabular-nums shrink-0 truncate", @label_width]}>
          <%= row.label %>
        </div>
        <div class="flex-1 h-4 min-w-0">
          <div
            class="h-full rounded-r"
            style={"width: #{pct(row.value, @max)}%; background-color: #{@color}"}
          >
          </div>
        </div>
        <div class="w-16 text-xs text-zinc-400 text-right tabular-nums shrink-0">
          <%= row.display %>
        </div>
      </div>
    </div>
    """
  end

  # Stacked daily cost by model. Segments carry a 2px surface gap so adjacent
  # fills stay separable without relying on hue alone.
  attr :series, :list, required: true
  attr :models, :list, required: true
  attr :max, :float, required: true

  defp stacked(assigns) do
    ~H"""
    <div class="space-y-1">
      <div :for={day <- @series} class="flex items-center gap-2">
        <div class="w-16 text-xs text-zinc-500 tabular-nums shrink-0">
          <%= format_date(day.date) %>
        </div>
        <div class="flex-1 h-4 flex gap-[2px] min-w-0">
          <div
            :for={model <- @models}
            :if={cost_of(day, model) > 0}
            class="h-full first:rounded-l last:rounded-r"
            style={"width: #{pct(cost_of(day, model), @max)}%; background-color: #{model_color(model)}"}
            title={"#{model_label(model)} · #{format_date(day.date)}: $#{Float.round(cost_of(day, model), 4)}"}
          >
          </div>
        </div>
        <div class="w-16 text-xs text-zinc-400 text-right tabular-nums shrink-0">
          <%= day_total_label(day, @models) %>
        </div>
      </div>
    </div>
    """
  end

  # Helpers

  defp model_color(model), do: Map.get(@model_colors, model, @fallback_color)

  defp model_label(model), do: Manfrod.Pricing.label(model)

  defp cost_of(day, model) do
    case Map.get(day.models, model) do
      nil -> 0.0
      %{cost_usd: cost} -> Decimal.to_float(cost)
    end
  end

  defp max_daily_cost(series) do
    series
    |> Enum.map(fn day ->
      day.models |> Map.values() |> Enum.map(&Decimal.to_float(&1.cost_usd)) |> Enum.sum()
    end)
    |> Enum.max(fn -> 0.0 end)
    |> max(0.0001)
  end

  defp day_total_label(day, models) do
    total = Enum.reduce(models, 0.0, fn model, acc -> acc + cost_of(day, model) end)

    if total > 0, do: "$#{Float.round(total, 4)}", else: "–"
  end

  defp pct(_value, max) when max <= 0, do: 0
  defp pct(value, max), do: Float.round(value / max * 100, 2)

  defp money(%Decimal{} = value) do
    value
    |> Decimal.round(4)
    |> Decimal.to_string(:normal)
  end

  defp money(value), do: to_string(value)

  defp rate(value) when value <= 0, do: "free"
  defp rate(value), do: "$#{value}"

  defp cache_write_rate(%{
         cache_write_per_mtok: base,
         cache_write_above_per_mtok: above,
         cache_write_threshold: threshold
       })
       when is_number(above) and is_integer(threshold) do
    "$#{base} / $#{above} >#{div(threshold, 1000)}K"
  end

  defp cache_write_rate(%{cache_write_per_mtok: base}) when base <= 0, do: "–"
  defp cache_write_rate(%{cache_write_per_mtok: base}), do: "$#{base}"

  defp format_date(nil), do: "–"
  defp format_date(date), do: Calendar.strftime(date, "%m/%d")

  @timezone "Europe/Warsaw"

  # Ratings are a handful of rows an admin reads one by one, so unlike the
  # chart axes these get a real local timestamp rather than a compact label.
  defp format_datetime(nil), do: "–"

  defp format_datetime(%DateTime{} = at) do
    at
    |> DateTime.shift_zone!(@timezone)
    |> Calendar.strftime("%m/%d %H:%M")
  end

  defp format_datetime(%NaiveDateTime{} = at) do
    at
    |> DateTime.from_naive!("Etc/UTC")
    |> format_datetime()
  end

  # Nobody has to be a provisioned user to rate an answer, so fall back
  # through the denormalized Slack name to the raw id.
  defp satisfaction_value(%{score: nil}), do: "–"
  defp satisfaction_value(%{score: score}), do: "#{score}%"

  defp satisfaction_sub(%{total: 0}), do: "no ratings yet"

  defp satisfaction_sub(%{good: good, bad: bad, total: total}) do
    "#{good} good / #{bad} bad of #{total}"
  end

  defp rater(%{user: %{name: name}}) when is_binary(name) and name != "", do: name
  defp rater(%{slack_user_name: name}) when is_binary(name) and name != "", do: name
  defp rater(%{slack_user_id: id}) when is_binary(id), do: id
  defp rater(_feedback), do: "unknown"

  defp where(%{slack_channel_name: "DM"}), do: "DM"
  defp where(%{slack_channel_name: name}) when is_binary(name) and name != "", do: "##{name}"
  defp where(%{slack_channel_id: id}) when is_binary(id), do: id
  defp where(_feedback), do: "–"

  defp format_number(n) when is_integer(n) and n >= 1_000_000,
    do: "#{Float.round(n / 1_000_000, 1)}M"

  defp format_number(n) when is_integer(n) and n >= 1_000, do: "#{Float.round(n / 1_000, 1)}K"
  defp format_number(n), do: to_string(n)

  defp delta_label(current, previous, suffix) do
    cond do
      Decimal.equal?(previous, Decimal.new(0)) ->
        "no prior period"

      true ->
        change =
          current
          |> Decimal.sub(previous)
          |> Decimal.div(previous)
          |> Decimal.mult(Decimal.new(100))
          |> Decimal.round(0)

        sign = if Decimal.negative?(change), do: "", else: "+"
        "#{sign}#{Decimal.to_string(change, :normal)}% #{suffix}"
    end
  end
end
