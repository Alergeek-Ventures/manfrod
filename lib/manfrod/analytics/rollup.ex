defmodule Manfrod.Analytics.Rollup do
  @moduledoc """
  Aggregates raw `audit_events` into the daily rollup tables.

  Raw events are purged after 7 days (`Manfrod.Events.Persister`), so this must
  run before a day ages out — `Manfrod.Workers.RollupWorker` runs it nightly
  over a lookback window wide enough to absorb a few missed nights.

  Every run is idempotent: a day is recomputed from scratch and upserted onto
  the unique grain index, so running it twice (or backfilling over days that are
  already rolled up) produces the same rows rather than doubling them.
  """

  import Ecto.Query

  require Logger

  alias Manfrod.Analytics.ActivityRollup
  alias Manfrod.Analytics.ToolRollup
  alias Manfrod.Analytics.UsageRollup
  alias Manfrod.Events.AuditEvent
  alias Manfrod.Pricing
  alias Manfrod.Repo

  @usage_types ["llm_call_succeeded", "llm_call_failed", "llm_retry", "llm_fallback"]
  @activity_types [
    "message_received",
    "responding",
    "action_started",
    "idle",
    "memory_searched",
    "memory_node_created"
  ]

  @doc """
  Roll up a single UTC date into all rollup tables.

  Returns `{usage_rows, activity_rows, tool_rows}` written.
  """
  @spec run_for_date(Date.t()) :: {non_neg_integer(), non_neg_integer(), non_neg_integer()}
  def run_for_date(%Date{} = date) do
    {day_start, day_end} = day_bounds(date)

    usage = rollup_usage(date, day_start, day_end)
    activity = rollup_activity(date, day_start, day_end)
    tool = rollup_tool(date, day_start, day_end)

    {usage, activity, tool}
  end

  @doc """
  Roll up the last `days` days, most recent first.

  Defaults to a 3-day window so a couple of missed nightly runs still get
  picked up before the 7-day raw retention drops the events.
  """
  @spec run_recent(pos_integer()) :: :ok
  def run_recent(days \\ 3) do
    today = Date.utc_today()

    for offset <- 0..(days - 1) do
      date = Date.add(today, -offset)
      {usage, activity, tool} = run_for_date(date)

      Logger.debug(
        "Rollup #{date}: #{usage} usage rows, #{activity} activity rows, #{tool} tool rows"
      )
    end

    :ok
  end

  @doc """
  Backfill rollups for every date that still has raw events.

  Safe to run repeatedly — recomputes and upserts. Used once after the rollup
  tables are introduced so existing history isn't lost.
  """
  @spec backfill() :: :ok
  def backfill do
    dates =
      AuditEvent
      |> where([e], e.type in ^(@usage_types ++ @activity_types))
      |> select([e], fragment("DISTINCT (?)::date", e.timestamp))
      |> Repo.all()

    Logger.info("Analytics backfill: #{length(dates)} day(s) with raw events")

    for date <- Enum.sort(dates, Date) do
      {usage, activity, tool} = run_for_date(date)

      Logger.info(
        "Analytics backfill #{date}: #{usage} usage rows, #{activity} activity rows, #{tool} tool rows"
      )
    end

    :ok
  end

  # Usage grain: date x user x model x purpose

  defp rollup_usage(date, day_start, day_end) do
    events =
      AuditEvent
      |> where([e], e.timestamp >= ^day_start and e.timestamp < ^day_end)
      |> where([e], e.type in ^@usage_types)
      |> Repo.all()

    rows =
      events
      |> Enum.group_by(&usage_key/1)
      |> Enum.map(fn {{user_id, model, purpose}, group} ->
        succeeded = Enum.filter(group, &(&1.type == "llm_call_succeeded"))
        first = List.first(group)

        tokens = %{
          input_tokens: sum_meta(succeeded, "input_tokens"),
          output_tokens: sum_meta(succeeded, "output_tokens"),
          cached_tokens: sum_meta(succeeded, "cached_tokens"),
          cache_creation_tokens: sum_meta(succeeded, "cache_creation_tokens")
        }

        # Prefer the cost stamped on the event at call time; fall back to
        # pricing the tokens now for events written before cost_usd existed.
        stamped_cost = sum_meta_float(succeeded, "cost_usd")
        cost = if stamped_cost > 0, do: stamped_cost, else: Pricing.cost(model, tokens)

        Map.merge(tokens, %{
          date: date,
          user_id: user_id,
          model: model,
          purpose: purpose,
          provider: meta(first, "provider"),
          tier: meta(first, "tier"),
          calls: length(succeeded),
          failed_calls: count_type(group, "llm_call_failed"),
          retries: count_type(group, "llm_retry"),
          fallbacks: count_type(group, "llm_fallback"),
          cost_usd: to_decimal(cost),
          uncached_cost_usd: to_decimal(Pricing.uncached_cost(model, tokens)),
          total_latency_ms: sum_meta(succeeded, "latency_ms")
        })
      end)

    upsert(UsageRollup, rows, [:date, :user_id, :model, :purpose], UsageRollup.upsert_fields())
  end

  # A fallback event names the model it moved *away* from; group it with that
  # model so the retry/fallback counts sit next to the calls they belong to.
  defp usage_key(%{type: "llm_fallback"} = event) do
    {event.user_id, meta(event, "from_model") || "unknown", meta(event, "purpose") || "unknown"}
  end

  defp usage_key(event) do
    {event.user_id, meta(event, "model") || "unknown", meta(event, "purpose") || "unknown"}
  end

  # Activity grain: date x user

  defp rollup_activity(date, day_start, day_end) do
    events =
      AuditEvent
      |> where([e], e.timestamp >= ^day_start and e.timestamp < ^day_end)
      |> where([e], e.type in ^@activity_types)
      |> where([e], not is_nil(e.user_id))
      |> Repo.all()

    rows =
      events
      |> Enum.group_by(& &1.user_id)
      |> Enum.map(fn {user_id, group} ->
        %{
          date: date,
          user_id: user_id,
          messages_received: count_type(group, "message_received"),
          messages_sent: count_type(group, "responding"),
          tool_calls: count_type(group, "action_started"),
          # An `idle` event is emitted once per participant when a session
          # times out, so it counts completed conversations for that user.
          sessions: count_type(group, "idle"),
          memory_searches: count_type(group, "memory_searched"),
          notes_created: count_type(group, "memory_node_created")
        }
      end)

    upsert(ActivityRollup, rows, [:date, :user_id], ActivityRollup.upsert_fields())
  end

  # Tool grain: date x tool name

  defp rollup_tool(date, day_start, day_end) do
    rows =
      AuditEvent
      |> where([e], e.timestamp >= ^day_start and e.timestamp < ^day_end)
      |> where([e], e.type == "action_started")
      |> Repo.all()
      |> Enum.group_by(&(meta(&1, "action") || "unknown"))
      |> Enum.map(fn {tool, group} ->
        %{date: date, tool: tool, calls: length(group)}
      end)

    upsert(ToolRollup, rows, [:date, :tool], ToolRollup.upsert_fields())
  end

  # Shared helpers

  defp upsert(_schema, [], _target, _fields), do: 0

  defp upsert(schema, rows, conflict_target, replace_fields) do
    now = NaiveDateTime.utc_now() |> NaiveDateTime.truncate(:second)

    entries =
      Enum.map(rows, fn row ->
        row
        |> Map.put(:id, Ecto.UUID.generate())
        |> Map.put(:inserted_at, now)
        |> Map.put(:updated_at, now)
      end)

    {count, _} =
      Repo.insert_all(schema, entries,
        on_conflict: {:replace, replace_fields ++ [:updated_at]},
        conflict_target: conflict_target
      )

    count
  end

  defp day_bounds(date) do
    {:ok, start_naive} = NaiveDateTime.new(date, ~T[00:00:00])
    day_start = DateTime.from_naive!(start_naive, "Etc/UTC")
    {day_start, DateTime.add(day_start, 1, :day)}
  end

  defp meta(nil, _key), do: nil
  defp meta(event, key), do: get_in(event.meta, [key])

  defp count_type(events, type), do: Enum.count(events, &(&1.type == type))

  defp sum_meta(events, key) do
    events
    |> Enum.map(fn e -> to_integer(meta(e, key)) end)
    |> Enum.sum()
  end

  defp sum_meta_float(events, key) do
    events
    |> Enum.map(fn e -> to_float(meta(e, key)) end)
    |> Enum.sum()
  end

  defp to_integer(n) when is_integer(n), do: n
  defp to_integer(n) when is_float(n), do: trunc(n)
  defp to_integer(_), do: 0

  defp to_float(n) when is_float(n), do: n
  defp to_float(n) when is_integer(n), do: n * 1.0
  defp to_float(_), do: 0.0

  defp to_decimal(value) when is_float(value) do
    value |> Decimal.from_float() |> Decimal.round(8)
  end

  defp to_decimal(value), do: Decimal.new(value)
end
