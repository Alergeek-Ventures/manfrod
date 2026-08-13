defmodule Manfrod.Analytics do
  @moduledoc """
  Read API over the daily rollup tables for the admin analytics page.

  Every function takes a `days` window and reports on the last `days` days
  ending today (UTC). All figures come from the rollup tables rather than raw
  `audit_events`, so windows longer than the 7-day raw retention still work.

  System users (the retrospector and skill-runner service accounts) are real
  rows in `users` but are not people — adoption metrics exclude them, while cost
  metrics keep them, since their spend is real money.
  """

  import Ecto.Query

  alias Manfrod.Accounts.User
  alias Manfrod.Analytics.ActivityRollup
  alias Manfrod.Analytics.ToolRollup
  alias Manfrod.Analytics.UsageRollup
  alias Manfrod.Feedback
  alias Manfrod.Pricing
  alias Manfrod.Repo

  @system_slack_id_prefix "system:"

  # Tools that carry out a real-world action the user asked for by name —
  # booking a desk, opening a door, setting a reminder. Anything not listed
  # here (reads, listings, memory search, admin upkeep) defaults to
  # `:everyday`: the routine calls the agent makes on the way to answering,
  # not something a person would describe as "I asked it to do X".
  @intent_tools MapSet.new([
                  "reserve_desk",
                  "cancel_desk_reservation",
                  "open_office_door",
                  "set_reminder",
                  "cancel_reminder",
                  "create_recurring_reminder",
                  "update_recurring_reminder",
                  "delete_recurring_reminder",
                  "escalate_note",
                  "ask_user_about_holiday",
                  "record_holiday_plan",
                  "report_vacation",
                  "create_note",
                  "delete_note",
                  "link_notes",
                  "unlink_notes",
                  "delete_slack_message"
                ])

  @doc """
  Everything the analytics page needs, in one call.
  """
  def overview(days \\ 30) do
    %{
      days: days,
      range: date_range(days),
      summary: summary(days),
      daily: daily_series(days),
      by_model: by_model(days),
      by_purpose: by_purpose(days),
      by_user: by_user(days),
      by_tool: by_tool(days),
      model_timeline: model_timeline(days),
      adoption: adoption(days),
      # Ratings come straight from `message_feedback`, not the rollups: a few
      # clicks a day needs no pre-aggregation, and the negative list has to
      # keep the individual rows anyway.
      feedback: Feedback.stats(days),
      negative_feedback: Feedback.list_negative(days),
      pricing: pricing_rows()
    }
  end

  @doc """
  Headline totals for the window, with the previous window for comparison.
  """
  def summary(days) do
    current = totals_between(start_date(days), Date.utc_today())

    prev_end = Date.add(start_date(days), -1)
    previous = totals_between(Date.add(prev_end, -(days - 1)), prev_end)

    active = active_user_count(days)
    prev_active = active_user_count_between(Date.add(prev_end, -(days - 1)), prev_end)

    Map.merge(current, %{
      active_users: active,
      previous_active_users: prev_active,
      total_people: people_count(),
      previous_cost_usd: previous.cost_usd,
      previous_calls: previous.calls,
      previous_messages: previous.messages_received,
      cost_per_active_user: safe_div(current.cost_usd, active),
      cost_per_message: safe_div(current.cost_usd, current.messages_received),
      cache_savings_usd: Decimal.sub(current.uncached_cost_usd, current.cost_usd),
      cache_hit_rate: safe_ratio(current.cached_tokens, current.input_tokens),
      projected_monthly_cost: projected_monthly(current.cost_usd, days)
    })
  end

  @doc """
  Per-day series combining spend, usage, and activity — one row per date with
  no gaps, so charts render a continuous axis.
  """
  def daily_series(days) do
    usage =
      UsageRollup
      |> where([r], r.date >= ^start_date(days))
      |> group_by([r], r.date)
      |> select([r], %{
        date: r.date,
        calls: sum(r.calls),
        input_tokens: sum(r.input_tokens),
        output_tokens: sum(r.output_tokens),
        cached_tokens: sum(r.cached_tokens),
        cost_usd: sum(r.cost_usd),
        failed_calls: sum(r.failed_calls)
      })
      |> Repo.all()
      |> Map.new(&{&1.date, &1})

    activity =
      ActivityRollup
      |> where([r], r.date >= ^start_date(days))
      |> active_rows()
      |> join(:inner, [r], u in User, on: u.id == r.user_id)
      |> where([r, u], not like(u.slack_id, ^(@system_slack_id_prefix <> "%")))
      |> group_by([r], r.date)
      |> select([r], %{
        date: r.date,
        messages_received: sum(r.messages_received),
        messages_sent: sum(r.messages_sent),
        tool_calls: sum(r.tool_calls),
        active_users: count(r.user_id, :distinct)
      })
      |> Repo.all()
      |> Map.new(&{&1.date, &1})

    for date <- date_list(days) do
      u = Map.get(usage, date, %{})
      a = Map.get(activity, date, %{})

      %{
        date: date,
        calls: int(u[:calls]),
        failed_calls: int(u[:failed_calls]),
        input_tokens: int(u[:input_tokens]),
        output_tokens: int(u[:output_tokens]),
        cached_tokens: int(u[:cached_tokens]),
        cost_usd: dec(u[:cost_usd]),
        messages_received: int(a[:messages_received]),
        messages_sent: int(a[:messages_sent]),
        tool_calls: int(a[:tool_calls]),
        active_users: int(a[:active_users])
      }
    end
  end

  @doc """
  Cost and usage per model, most expensive first. This is where the
  DeepSeek to GPT switch shows up as two rows.
  """
  def by_model(days) do
    UsageRollup
    |> where([r], r.date >= ^start_date(days))
    |> group_by([r], r.model)
    |> select([r], %{
      model: r.model,
      calls: sum(r.calls),
      failed_calls: sum(r.failed_calls),
      retries: sum(r.retries),
      fallbacks: sum(r.fallbacks),
      input_tokens: sum(r.input_tokens),
      output_tokens: sum(r.output_tokens),
      cached_tokens: sum(r.cached_tokens),
      cost_usd: sum(r.cost_usd),
      uncached_cost_usd: sum(r.uncached_cost_usd),
      total_latency_ms: sum(r.total_latency_ms),
      first_seen: min(r.date),
      last_seen: max(r.date)
    })
    |> Repo.all()
    |> Enum.map(fn row ->
      calls = int(row.calls)

      row
      |> normalize_usage_row()
      |> Map.merge(%{
        label: Pricing.label(row.model),
        free: Pricing.free?(row.model),
        unpriced: not Pricing.known?(row.model),
        avg_latency_ms: safe_div_int(int(row.total_latency_ms), calls),
        cost_per_call: safe_div(dec(row.cost_usd), calls),
        cache_hit_rate: safe_ratio(int(row.cached_tokens), int(row.input_tokens))
      })
    end)
    |> Enum.sort_by(& &1.cost_usd, {:desc, Decimal})
  end

  @doc """
  Per-day cost split by model — shows the switchover as one line ending where
  the other begins.
  """
  def model_timeline(days) do
    rows =
      UsageRollup
      |> where([r], r.date >= ^start_date(days))
      |> group_by([r], [r.date, r.model])
      |> select([r], %{
        date: r.date,
        model: r.model,
        calls: sum(r.calls),
        cost_usd: sum(r.cost_usd)
      })
      |> Repo.all()

    models = rows |> Enum.map(& &1.model) |> Enum.uniq() |> Enum.sort()
    by_date = Enum.group_by(rows, & &1.date)

    series =
      for date <- date_list(days) do
        day_rows = Map.get(by_date, date, [])

        values =
          Map.new(models, fn model ->
            row = Enum.find(day_rows, &(&1.model == model))

            {model,
             %{
               calls: if(row, do: int(row.calls), else: 0),
               cost_usd: if(row, do: dec(row.cost_usd), else: Decimal.new(0))
             }}
          end)

        %{date: date, models: values}
      end

    %{models: models, series: series}
  end

  @doc """
  Cost and usage per purpose — which subsystem (agent, retrospector,
  classifier, ...) is actually consuming the budget.
  """
  def by_purpose(days) do
    UsageRollup
    |> where([r], r.date >= ^start_date(days))
    |> group_by([r], r.purpose)
    |> select([r], %{
      purpose: r.purpose,
      calls: sum(r.calls),
      input_tokens: sum(r.input_tokens),
      output_tokens: sum(r.output_tokens),
      cached_tokens: sum(r.cached_tokens),
      cost_usd: sum(r.cost_usd),
      uncached_cost_usd: sum(r.uncached_cost_usd)
    })
    |> Repo.all()
    |> Enum.map(&normalize_usage_row/1)
    |> Enum.sort_by(& &1.cost_usd, {:desc, Decimal})
  end

  @doc """
  Which tools actually get called, most frequent first, split into two
  groups: `:everyday` (reads, listings, memory fetches — the routine calls
  the agent makes on the way to answering) and `:intent` (an action the user
  asked for by name — booking a desk, opening the door, setting a reminder).
  """
  def by_tool(days) do
    rows =
      ToolRollup
      |> where([r], r.date >= ^start_date(days))
      |> group_by([r], r.tool)
      |> select([r], %{tool: r.tool, calls: sum(r.calls)})
      |> Repo.all()
      |> Enum.map(fn row ->
        %{tool: row.tool, calls: int(row.calls), category: tool_category(row.tool)}
      end)
      |> Enum.sort_by(& &1.calls, :desc)

    %{
      all: rows,
      everyday: Enum.filter(rows, &(&1.category == :everyday)),
      intent: Enum.filter(rows, &(&1.category == :intent)),
      total_calls: Enum.sum(Enum.map(rows, & &1.calls))
    }
  end

  @doc """
  Per-person adoption and spend, most active first.

  Cost is only attributable for calls made after user attribution was added to
  the LLM layer, so `cost_usd` can read 0 for a user who was clearly active in
  the same window — `attributed?` flags that case for the UI.
  """
  def by_user(days) do
    from_date = start_date(days)

    activity =
      ActivityRollup
      |> where([r], r.date >= ^from_date)
      |> group_by([r], r.user_id)
      |> select([r], %{
        user_id: r.user_id,
        messages_received: sum(r.messages_received),
        messages_sent: sum(r.messages_sent),
        tool_calls: sum(r.tool_calls),
        sessions: sum(r.sessions),
        memory_searches: sum(r.memory_searches),
        notes_created: sum(r.notes_created),
        active_days: count(r.date, :distinct),
        last_active: max(r.date)
      })
      |> Repo.all()
      |> Map.new(&{&1.user_id, &1})

    usage =
      UsageRollup
      |> where([r], r.date >= ^from_date)
      |> where([r], not is_nil(r.user_id))
      |> group_by([r], r.user_id)
      |> select([r], %{
        user_id: r.user_id,
        calls: sum(r.calls),
        input_tokens: sum(r.input_tokens),
        output_tokens: sum(r.output_tokens),
        cost_usd: sum(r.cost_usd)
      })
      |> Repo.all()
      |> Map.new(&{&1.user_id, &1})

    Repo.all(from(u in User, order_by: u.name))
    |> Enum.map(fn user ->
      a = Map.get(activity, user.id, %{})
      p = Map.get(usage, user.id, %{})

      messages = int(a[:messages_received])

      %{
        user_id: user.id,
        name: user.name || user.email || user.slack_id,
        email: user.email,
        system: system_user?(user),
        messages_received: messages,
        messages_sent: int(a[:messages_sent]),
        tool_calls: int(a[:tool_calls]),
        sessions: int(a[:sessions]),
        memory_searches: int(a[:memory_searches]),
        notes_created: int(a[:notes_created]),
        active_days: int(a[:active_days]),
        last_active: a[:last_active],
        calls: int(p[:calls]),
        input_tokens: int(p[:input_tokens]),
        output_tokens: int(p[:output_tokens]),
        cost_usd: dec(p[:cost_usd]),
        attributed?: int(p[:calls]) > 0
      }
    end)
    |> Enum.reject(&(&1.messages_received == 0 and &1.calls == 0 and &1.active_days == 0))
    |> Enum.sort_by(&{&1.messages_received, &1.active_days}, :desc)
  end

  @doc """
  Adoption view: who is using the bot, how consistently, and whether that is
  growing.

  - `weekly` — active people and volume per ISO week
  - `reach` — how many of the provisioned people used the bot at all
  - `stickiness` — DAU/MAU style ratio of avg daily actives to window actives
  """
  def adoption(days) do
    from_date = start_date(days)

    weekly =
      ActivityRollup
      |> where([r], r.date >= ^from_date)
      |> active_rows()
      |> join(:inner, [r], u in User, on: u.id == r.user_id)
      |> where([r, u], not like(u.slack_id, ^(@system_slack_id_prefix <> "%")))
      |> group_by([r], fragment("date_trunc('week', ?)", r.date))
      |> select([r], %{
        week: fragment("date_trunc('week', ?)::date", r.date),
        active_users: count(r.user_id, :distinct),
        messages: sum(r.messages_received),
        sessions: sum(r.sessions)
      })
      |> order_by([r], fragment("date_trunc('week', ?)", r.date))
      |> Repo.all()
      |> Enum.map(&%{&1 | messages: int(&1.messages), sessions: int(&1.sessions)})

    active = active_user_count(days)
    people = people_count()

    avg_daily =
      case daily_series(days) do
        [] -> 0.0
        series -> Enum.sum(Enum.map(series, & &1.active_users)) / length(series)
      end

    %{
      weekly: weekly,
      active_users: active,
      total_people: people,
      never_used: max(people - active, 0),
      reach: safe_ratio(active, people),
      avg_daily_active: Float.round(avg_daily, 1),
      stickiness: if(active > 0, do: Float.round(avg_daily / active, 3), else: 0.0)
    }
  end

  @doc """
  The pricing table as display rows, so the page can show what the costs are
  based on.
  """
  def pricing_rows do
    Pricing.table()
    |> Enum.map(fn {model, price} -> Map.put(price, :model, model) end)
    |> Enum.sort_by(&{&1.free, &1.model})
  end

  # Internals

  defp totals_between(from_date, to_date) do
    usage =
      UsageRollup
      |> where([r], r.date >= ^from_date and r.date <= ^to_date)
      |> select([r], %{
        calls: sum(r.calls),
        failed_calls: sum(r.failed_calls),
        retries: sum(r.retries),
        fallbacks: sum(r.fallbacks),
        input_tokens: sum(r.input_tokens),
        output_tokens: sum(r.output_tokens),
        cached_tokens: sum(r.cached_tokens),
        cache_creation_tokens: sum(r.cache_creation_tokens),
        cost_usd: sum(r.cost_usd),
        uncached_cost_usd: sum(r.uncached_cost_usd),
        total_latency_ms: sum(r.total_latency_ms)
      })
      |> Repo.one() || %{}

    activity =
      ActivityRollup
      |> where([r], r.date >= ^from_date and r.date <= ^to_date)
      |> join(:inner, [r], u in User, on: u.id == r.user_id)
      |> where([r, u], not like(u.slack_id, ^(@system_slack_id_prefix <> "%")))
      |> select([r], %{
        messages_received: sum(r.messages_received),
        messages_sent: sum(r.messages_sent),
        tool_calls: sum(r.tool_calls),
        sessions: sum(r.sessions)
      })
      |> Repo.one() || %{}

    calls = int(usage[:calls])

    %{
      calls: calls,
      failed_calls: int(usage[:failed_calls]),
      retries: int(usage[:retries]),
      fallbacks: int(usage[:fallbacks]),
      input_tokens: int(usage[:input_tokens]),
      output_tokens: int(usage[:output_tokens]),
      cached_tokens: int(usage[:cached_tokens]),
      cache_creation_tokens: int(usage[:cache_creation_tokens]),
      cost_usd: dec(usage[:cost_usd]),
      uncached_cost_usd: dec(usage[:uncached_cost_usd]),
      avg_latency_ms: safe_div_int(int(usage[:total_latency_ms]), calls),
      messages_received: int(activity[:messages_received]),
      messages_sent: int(activity[:messages_sent]),
      tool_calls: int(activity[:tool_calls]),
      sessions: int(activity[:sessions])
    }
  end

  defp active_user_count(days),
    do: active_user_count_between(start_date(days), Date.utc_today())

  defp active_user_count_between(from_date, to_date) do
    ActivityRollup
    |> where([r], r.date >= ^from_date and r.date <= ^to_date)
    |> active_rows()
    |> join(:inner, [r], u in User, on: u.id == r.user_id)
    |> where([r, u], not like(u.slack_id, ^(@system_slack_id_prefix <> "%")))
    |> select([r], count(r.user_id, :distinct))
    |> Repo.one() || 0
  end

  # "Active" is any interaction with the bot, not messages alone: the
  # `message_received` event was only added later, so rows rolled up before
  # that would look inactive despite obvious sessions and tool calls.
  defp active_rows(query) do
    where(
      query,
      [r],
      r.messages_received > 0 or r.sessions > 0 or r.tool_calls > 0 or r.messages_sent > 0
    )
  end

  defp people_count do
    User
    |> where([u], not like(u.slack_id, ^(@system_slack_id_prefix <> "%")))
    |> select([u], count(u.id))
    |> Repo.one() || 0
  end

  defp system_user?(%User{slack_id: slack_id}) when is_binary(slack_id),
    do: String.starts_with?(slack_id, @system_slack_id_prefix)

  defp system_user?(_user), do: false

  defp tool_category(tool) do
    if MapSet.member?(@intent_tools, tool), do: :intent, else: :everyday
  end

  defp normalize_usage_row(row) do
    row
    |> Map.replace_lazy(:calls, &int/1)
    |> Map.replace_lazy(:failed_calls, &int/1)
    |> Map.replace_lazy(:retries, &int/1)
    |> Map.replace_lazy(:fallbacks, &int/1)
    |> Map.replace_lazy(:input_tokens, &int/1)
    |> Map.replace_lazy(:output_tokens, &int/1)
    |> Map.replace_lazy(:cached_tokens, &int/1)
    |> Map.replace_lazy(:total_latency_ms, &int/1)
    |> Map.replace_lazy(:cost_usd, &dec/1)
    |> Map.replace_lazy(:uncached_cost_usd, &dec/1)
  end

  defp projected_monthly(cost, days) when days > 0 do
    cost
    |> Decimal.div(Decimal.new(days))
    |> Decimal.mult(Decimal.new(30))
    |> Decimal.round(4)
  end

  defp date_range(days), do: {start_date(days), Date.utc_today()}

  defp start_date(days), do: Date.add(Date.utc_today(), -(days - 1))

  defp date_list(days) do
    today = Date.utc_today()
    for offset <- (days - 1)..0//-1, do: Date.add(today, -offset)
  end

  defp int(nil), do: 0
  defp int(n) when is_integer(n), do: n
  defp int(%Decimal{} = d), do: Decimal.to_integer(d)
  defp int(n) when is_float(n), do: trunc(n)

  defp dec(nil), do: Decimal.new(0)
  defp dec(%Decimal{} = d), do: d
  defp dec(n) when is_integer(n), do: Decimal.new(n)
  defp dec(n) when is_float(n), do: Decimal.from_float(n)

  defp safe_div(_value, 0), do: Decimal.new(0)

  defp safe_div(value, divisor),
    do: value |> dec() |> Decimal.div(Decimal.new(divisor)) |> Decimal.round(6)

  defp safe_div_int(_value, 0), do: 0
  defp safe_div_int(value, divisor), do: div(value, divisor)

  defp safe_ratio(_part, 0), do: 0.0
  defp safe_ratio(part, whole), do: Float.round(part / whole * 100, 1)
end
