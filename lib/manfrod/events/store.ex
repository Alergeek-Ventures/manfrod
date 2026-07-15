defmodule Manfrod.Events.Store do
  @moduledoc """
  Persistence layer for audit events.

  Provides functions to insert, query, and clean up audit events.
  """

  import Ecto.Query

  alias Manfrod.Repo
  alias Manfrod.Events.Activity
  alias Manfrod.Events.AgentRun
  alias Manfrod.Events.AuditEvent

  @doc """
  Insert an Activity into the audit log.

  Returns `{:ok, audit_event}` or `{:error, changeset}`.
  """
  def insert(%Activity{} = activity) do
    activity
    |> AuditEvent.changeset_from_activity()
    |> Repo.insert()
  end

  @doc """
  Get audit events since a given timestamp, ordered chronologically.

  Options:
  - `:limit` - max events to return (default: 100)
  - `:types` - list of event types to filter (default: all)

  Returns a list of Activity structs.
  """
  def get_events_since(timestamp, opts \\ []) do
    limit = Keyword.get(opts, :limit, 100)
    types = Keyword.get(opts, :types, nil)

    query =
      AuditEvent
      |> where([e], e.timestamp > ^timestamp)
      |> order_by([e], asc: e.timestamp)
      |> limit(^limit)

    query =
      if types do
        type_strings = Enum.map(types, &to_string/1)
        where(query, [e], e.type in ^type_strings)
      else
        query
      end

    query
    |> Repo.all()
    |> Enum.map(&AuditEvent.to_activity/1)
  end

  @doc """
  List recent audit events, excluding debug/info logs by default.
  Pass `include_all_logs: true` to include all log levels.

  ## Options

  - `:include_all_logs` - include debug/info logs (default: false)
  - `:from` - filter events from this DateTime (inclusive)
  - `:to` - filter events until this DateTime (inclusive)
  - `:source` - filter by source (atom or string, e.g. :builder, "retrospector")

  Returns a list of Activity structs for compatibility with ActivityLive.
  """
  def list_recent_filtered(limit \\ 200, opts \\ []) do
    include_all_logs = Keyword.get(opts, :include_all_logs, false)
    from_dt = Keyword.get(opts, :from)
    to_dt = Keyword.get(opts, :to)
    source = Keyword.get(opts, :source)
    user_id = Keyword.get(opts, :user_id)

    query =
      AuditEvent
      |> order_by([e], desc: e.timestamp)
      |> limit(^limit)

    # Apply log level filter
    query =
      if include_all_logs do
        query
      else
        # Exclude debug/info logs, keep warning/error logs and all other event types
        where(
          query,
          [e],
          e.type != "log" or
            fragment("(?->>'level')::text", e.meta) in ["warning", "error"]
        )
      end

    # Apply time range filter
    query =
      if from_dt do
        where(query, [e], e.timestamp >= ^from_dt)
      else
        query
      end

    query =
      if to_dt do
        where(query, [e], e.timestamp <= ^to_dt)
      else
        query
      end

    # Apply source filter
    query =
      if source do
        source_str = to_string(source)
        where(query, [e], e.source == ^source_str)
      else
        query
      end

    # Apply user_id filter
    query =
      if user_id do
        where(query, [e], e.user_id == ^user_id)
      else
        query
      end

    query
    |> Repo.all()
    |> Enum.map(&AuditEvent.to_activity/1)
  end

  @doc """
  List events within a retrospection run's time window.

  Returns events from the retrospector and memory sources, excluding
  the run-level events (started/completed/failed) and LLM telemetry.
  Events are ordered chronologically (ascending) for conversation display.

  The `ended_at` may be nil for in-progress runs (uses current time).
  """
  def list_run_events(started_at, ended_at) do
    ended_at = ended_at || DateTime.utc_now()

    # Event types we want for the conversation view
    include_types = [
      "narrating",
      "action_started",
      "action_completed",
      "memory_node_created",
      "memory_node_updated",
      "memory_node_deleted",
      "memory_link_created",
      "memory_link_deleted",
      "memory_node_processed",
      "memory_searched"
    ]

    AuditEvent
    |> where([e], e.timestamp >= ^started_at and e.timestamp <= ^ended_at)
    |> where([e], e.source in ["retrospector", "memory"])
    |> where([e], e.type in ^include_types)
    |> order_by([e], asc: e.timestamp)
    |> Repo.all()
    |> Enum.map(&AuditEvent.to_activity/1)
  end

  @doc """
  Delete audit events older than the specified number of days.

  Returns `{count, nil}` where count is the number of deleted rows.
  """
  def delete_older_than(days) when is_integer(days) and days > 0 do
    cutoff = DateTime.add(DateTime.utc_now(), -days, :day)

    AuditEvent
    |> where([e], e.timestamp < ^cutoff)
    |> Repo.delete_all()
  end

  @doc """
  Delete log events older than the specified number of hours.
  Logs have shorter retention than other events.

  Returns `{count, nil}` where count is the number of deleted rows.
  """
  def delete_logs_older_than(hours) when is_integer(hours) and hours > 0 do
    cutoff = DateTime.add(DateTime.utc_now(), -hours, :hour)

    AuditEvent
    |> where([e], e.type == "log" and e.timestamp < ^cutoff)
    |> Repo.delete_all()
  end

  @doc """
  List Retrospector agent runs from the last N days.

  Correlates start/complete/fail events into AgentRun structs.

  Options:
  - `:days` - number of days to look back (default: 7)

  Returns a list of AgentRun structs, sorted by started_at descending.
  """
  def list_agent_runs(opts \\ []) do
    days = Keyword.get(opts, :days, 7)

    cutoff = DateTime.add(DateTime.utc_now(), -days, :day)

    event_types = [
      "retrospection_started",
      "retrospection_completed",
      "retrospection_failed"
    ]

    events =
      AuditEvent
      |> where([e], e.timestamp >= ^cutoff)
      |> where([e], e.type in ^event_types)
      |> order_by([e], asc: e.timestamp)
      |> Repo.all()

    build_retrospector_runs(events)
    |> Enum.sort_by(& &1.started_at, {:desc, DateTime})
  end

  defp build_retrospector_runs(events) do
    starts = Enum.filter(events, &(&1.type == "retrospection_started"))
    ends = Enum.filter(events, &(&1.type in ["retrospection_completed", "retrospection_failed"]))

    Enum.map(starts, fn start ->
      end_event =
        Enum.find(ends, fn e ->
          DateTime.compare(e.timestamp, start.timestamp) in [:gt, :eq] and
            not Enum.any?(starts, fn s ->
              s != start and
                DateTime.compare(s.timestamp, start.timestamp) == :gt and
                DateTime.compare(s.timestamp, e.timestamp) == :lt
            end)
        end)

      AgentRun.from_events(start, end_event)
    end)
  end

  @doc """
  Aggregate LLM metrics for the last N days.

  Returns a map with daily breakdowns and totals:
  - `:daily` - list of maps per day with counts
  - `:totals` - aggregate totals across all days

  Each daily entry contains:
  - `:date` - the date
  - `:free_calls` - LLM calls to free tier
  - `:paid_calls` - LLM calls to paid tier
  - `:retries` - retry events
  - `:fallbacks` - fallback events
  - `:input_tokens` - total input tokens
  - `:output_tokens` - total output tokens
  - `:messages_received` - user messages
  - `:messages_sent` - assistant responses
  - `:tool_calls` - action_started events
  """
  def aggregate_llm_metrics(days \\ 7) do
    cutoff = DateTime.add(DateTime.utc_now(), -days, :day)

    # Query all relevant events in the time range
    events =
      AuditEvent
      |> where([e], e.timestamp >= ^cutoff)
      |> where(
        [e],
        e.type in [
          "llm_call_succeeded",
          "llm_retry",
          "llm_fallback",
          "message_received",
          "responding",
          "action_started"
        ]
      )
      |> Repo.all()

    # Group by date and aggregate
    daily =
      events
      |> Enum.group_by(fn e -> DateTime.to_date(e.timestamp) end)
      |> Enum.map(fn {date, day_events} ->
        %{
          date: date,
          free_calls: count_by_type_and_tier(day_events, "llm_call_succeeded", "free"),
          paid_calls: count_by_type_and_tier(day_events, "llm_call_succeeded", "paid"),
          retries: count_by_type(day_events, "llm_retry"),
          fallbacks: count_by_type(day_events, "llm_fallback"),
          input_tokens: sum_meta_field(day_events, "llm_call_succeeded", "input_tokens"),
          output_tokens: sum_meta_field(day_events, "llm_call_succeeded", "output_tokens"),
          messages_received: count_by_type(day_events, "message_received"),
          messages_sent: count_by_type(day_events, "responding"),
          tool_calls: count_by_type(day_events, "action_started")
        }
      end)
      |> Enum.sort_by(& &1.date, Date)

    # Fill in missing days with zeros
    daily = fill_missing_days(daily, days)

    # Calculate totals
    totals = %{
      free_calls: Enum.sum(Enum.map(daily, & &1.free_calls)),
      paid_calls: Enum.sum(Enum.map(daily, & &1.paid_calls)),
      retries: Enum.sum(Enum.map(daily, & &1.retries)),
      fallbacks: Enum.sum(Enum.map(daily, & &1.fallbacks)),
      input_tokens: Enum.sum(Enum.map(daily, & &1.input_tokens)),
      output_tokens: Enum.sum(Enum.map(daily, & &1.output_tokens)),
      messages_received: Enum.sum(Enum.map(daily, & &1.messages_received)),
      messages_sent: Enum.sum(Enum.map(daily, & &1.messages_sent)),
      tool_calls: Enum.sum(Enum.map(daily, & &1.tool_calls))
    }

    %{daily: daily, totals: totals}
  end

  defp count_by_type(events, type) do
    Enum.count(events, &(&1.type == type))
  end

  defp count_by_type_and_tier(events, type, tier) do
    tier_str = to_string(tier)

    Enum.count(events, fn e ->
      e.type == type and get_in(e.meta, ["tier"]) == tier_str
    end)
  end

  defp sum_meta_field(events, type, field) do
    events
    |> Enum.filter(&(&1.type == type))
    |> Enum.map(fn e -> get_in(e.meta, [field]) || 0 end)
    |> Enum.sum()
  end

  defp fill_missing_days(daily, num_days) do
    today = Date.utc_today()
    all_dates = for i <- (num_days - 1)..0, do: Date.add(today, -i)

    existing_dates = MapSet.new(daily, & &1.date)

    missing =
      all_dates
      |> Enum.reject(&MapSet.member?(existing_dates, &1))
      |> Enum.map(fn date ->
        %{
          date: date,
          free_calls: 0,
          paid_calls: 0,
          retries: 0,
          fallbacks: 0,
          input_tokens: 0,
          output_tokens: 0,
          messages_received: 0,
          messages_sent: 0,
          tool_calls: 0
        }
      end)

    (daily ++ missing)
    |> Enum.sort_by(& &1.date, Date)
  end
end
