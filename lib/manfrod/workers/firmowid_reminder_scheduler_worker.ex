defmodule Manfrod.Workers.FirmowidReminderSchedulerWorker do
  @moduledoc """
  Runs hourly via Oban cron, but only does anything at 9am Europe/Warsaw on
  weekdays — self-gated rather than a fixed UTC crontab entry, since
  `Oban.Plugins.Cron` runs in UTC and Warsaw shifts between CET/CEST across
  the year.

  Replaces the old fixed 19:00-20:00 random-window check
  (`priv/skills/firmowid-session-check/SKILL.md`'s former `RAND(...)` cron)
  with a time tailored to each user: for every user connected to Firmowid,
  pulls their last `@session_sample_size` sessions, averages the time-of-day
  they ended, and schedules a `Manfrod.Workers.FirmowidSessionCheckWorker`
  run `@offset_minutes` after that predicted end-of-day time.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.Mcp
  alias Manfrod.Mcp.Client
  alias Manfrod.Workers.FirmowidSessionCheckWorker

  @provider "firmowid"
  @session_sample_size 100
  @offset_minutes 20
  @timezone "Europe/Warsaw"
  @unique_states [
    :available,
    :scheduled,
    :executing,
    :retryable,
    :completed,
    :cancelled,
    :discarded
  ]

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    now_local = DateTime.now!(@timezone)

    if run_now?(now_local) do
      run(now_local)
    end

    :ok
  end

  defp run_now?(now_local) do
    now_local.hour == 9 and Date.day_of_week(DateTime.to_date(now_local)) in 1..5
  end

  defp run(now_local) do
    case Enum.find(Mcp.builtin_providers(), &(&1.id == @provider)) do
      nil ->
        Logger.error("FirmowidReminderSchedulerWorker: missing '#{@provider}' provider")

      provider ->
        today = DateTime.to_date(now_local)

        count =
          @provider
          |> Mcp.list_connections_for_provider()
          |> Enum.reduce(0, fn conn, acc ->
            acc + schedule_for_connection(conn, provider, today)
          end)

        Logger.info("FirmowidReminderSchedulerWorker: scheduled #{count} check(s)")
    end
  end

  defp schedule_for_connection(conn, provider, today) do
    with {:ok, access_token} <- Mcp.ensure_valid_token(conn),
         {:ok, sessions} <- fetch_recent_sessions(provider.mcp_url, access_token),
         {:ok, avg_time} <- average_end_time(sessions) do
      schedule_reminder(conn.user_id, today, avg_time)
    else
      {:error, reason} ->
        Logger.debug(
          "FirmowidReminderSchedulerWorker: skipping #{conn.user_id}: #{inspect(reason)}"
        )

        0

      :error ->
        0
    end
  end

  defp fetch_recent_sessions(mcp_url, access_token) do
    case Client.call_tool(mcp_url, access_token, "list_sessions", %{
           "input" => %{},
           "limit" => @session_sample_size,
           "sort" => [%{"field" => "start_datetime", "direction" => "desc"}]
         }) do
      {:ok, result} -> {:ok, extract_sessions(result)}
      {:error, reason} -> {:error, reason}
    end
  end

  defp extract_sessions(%{"structuredContent" => %{"records" => records}})
       when is_list(records),
       do: records

  defp extract_sessions(%{"structuredContent" => records}) when is_list(records), do: records

  defp extract_sessions(%{"content" => content}) when is_list(content) do
    text =
      content
      |> Enum.map(fn
        %{"type" => "text", "text" => text} -> text
        _ -> nil
      end)
      |> Enum.reject(&is_nil/1)
      |> Enum.join("\n")

    case Jason.decode(text) do
      {:ok, list} when is_list(list) -> list
      {:ok, %{"records" => list}} when is_list(list) -> list
      _ -> []
    end
  end

  defp extract_sessions(_), do: []

  defp average_end_time(sessions) do
    seconds =
      sessions
      |> Enum.map(&Map.get(&1, "end_datetime"))
      |> Enum.reject(&is_nil/1)
      |> Enum.map(&seconds_of_day/1)
      |> Enum.reject(&is_nil/1)

    case seconds do
      [] -> :error
      list -> {:ok, Time.add(~T[00:00:00], round(Enum.sum(list) / length(list)), :second)}
    end
  end

  defp seconds_of_day(iso_string) do
    case DateTime.from_iso8601(iso_string) do
      {:ok, dt, _offset} ->
        local = DateTime.shift_zone!(dt, @timezone)
        local.hour * 3600 + local.minute * 60 + local.second

      {:error, _} ->
        nil
    end
  end

  defp schedule_reminder(user_id, date, avg_time) do
    reminder_at =
      date
      |> DateTime.new!(avg_time, @timezone)
      |> DateTime.add(@offset_minutes * 60, :second)
      |> DateTime.shift_zone!("Etc/UTC")

    if DateTime.compare(reminder_at, DateTime.utc_now()) == :gt do
      args = %{user_id: user_id, date: Date.to_iso8601(date)}

      case FirmowidSessionCheckWorker.new(args,
             scheduled_at: reminder_at,
             unique: [keys: [:user_id, :date], states: @unique_states, period: :infinity]
           )
           |> Oban.insert() do
        {:ok, %{conflict?: false}} -> 1
        {:ok, %{conflict?: true}} -> 0
        {:error, reason} -> log_schedule_error(user_id, reason)
      end
    else
      0
    end
  end

  defp log_schedule_error(user_id, reason) do
    Logger.error(
      "FirmowidReminderSchedulerWorker: failed to schedule check for #{user_id}: #{inspect(reason)}"
    )

    0
  end
end
