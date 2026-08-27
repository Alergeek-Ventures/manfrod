defmodule Manfrod.Workers.FirmowidMorningReminderSchedulerWorker do
  @moduledoc """
  Runs at 9pm Europe/Warsaw on Sun-Thu (`"0 21 * * 0-4"`), i.e. the evening
  before every weekday — `Oban.Plugins.Cron` is configured with `timezone:
  "Europe/Warsaw"`, so no DST juggling here.

  For every user connected to Firmowid, pulls their recent sessions
  (`Manfrod.Firmowid.SessionStats`), averages the *first* session's
  start-time per calendar day, and schedules a
  `Manfrod.Workers.FirmowidMorningSessionCheckWorker` run
  `@offset_minutes` after that predicted start-of-day time, for tomorrow.
  That worker checks whether the person opened the office door but never
  started a session, and if so, has Manfrod nudge them over DM.

  Mirrors `Manfrod.Workers.FirmowidReminderSchedulerWorker` (end-of-day),
  which schedules from the opposite end of the day.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.Accounts
  alias Manfrod.Firmowid.SessionStats
  alias Manfrod.Mcp
  alias Manfrod.Workers.FirmowidMorningSessionCheckWorker

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
    run(DateTime.now!(@timezone))
    :ok
  end

  defp run(now_local) do
    case Enum.find(Mcp.builtin_providers(), &(&1.id == @provider)) do
      nil ->
        Logger.error("FirmowidMorningReminderSchedulerWorker: missing '#{@provider}' provider")

      provider ->
        today = DateTime.to_date(now_local)
        target_date = Date.add(today, 1)

        count =
          @provider
          |> Mcp.list_connections_for_provider()
          |> Enum.reduce(0, fn conn, acc ->
            acc + schedule_for_connection(conn, provider, today, target_date)
          end)

        Logger.info("FirmowidMorningReminderSchedulerWorker: scheduled #{count} check(s)")
    end
  end

  defp schedule_for_connection(conn, provider, today, target_date) do
    with {:ok, access_token} <- Mcp.ensure_valid_token(conn),
         {:ok, sessions} <-
           SessionStats.fetch_recent_sessions(
             provider.mcp_url,
             access_token,
             @session_sample_size
           ),
         {:ok, avg_time} <-
           SessionStats.average_time_of_day(sessions, today, "start_datetime", :min) do
      schedule_check(conn.user_id, target_date, avg_time)
    else
      {:error, reason} ->
        Logger.debug(
          "FirmowidMorningReminderSchedulerWorker: skipping #{conn.user_id}: #{inspect(reason)}"
        )

        0

      :error ->
        0
    end
  end

  defp schedule_check(user_id, date, avg_time) do
    check_at_local =
      date
      |> DateTime.new!(avg_time, @timezone)
      |> DateTime.add(@offset_minutes * 60, :second)

    check_at = DateTime.shift_zone!(check_at_local, "Etc/UTC")

    if DateTime.compare(check_at, DateTime.utc_now()) == :gt do
      args = %{user_id: user_id, date: Date.to_iso8601(date)}
      user = Accounts.get_user!(user_id)

      meta = %{
        user_id: user_id,
        user_name: user.name,
        user_email: user.email,
        avg_start_time: Time.to_iso8601(avg_time),
        scheduled_for_local: DateTime.to_iso8601(check_at_local)
      }

      case FirmowidMorningSessionCheckWorker.new(args,
             scheduled_at: check_at,
             meta: meta,
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
      "FirmowidMorningReminderSchedulerWorker: failed to schedule check for #{user_id}: #{inspect(reason)}"
    )

    0
  end
end
