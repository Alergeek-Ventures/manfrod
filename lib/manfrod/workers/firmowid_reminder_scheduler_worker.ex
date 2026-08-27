defmodule Manfrod.Workers.FirmowidReminderSchedulerWorker do
  @moduledoc """
  Runs at 9am Europe/Warsaw on weekdays (`Oban.Plugins.Cron` is configured
  with `timezone: "Europe/Warsaw"`, so `"0 9 * * 1-5"` needs no DST
  juggling here).

  Replaces the old fixed 19:00-20:00 random-window check
  (`priv/skills/firmowid-session-check/SKILL.md`'s former `RAND(...)` cron)
  with a time tailored to each user: for every user connected to Firmowid,
  pulls their recent sessions (`Manfrod.Firmowid.SessionStats`), averages
  the *last* session's end-time per calendar day, and schedules a
  `Manfrod.Workers.FirmowidSessionCheckWorker` run `@offset_minutes` after
  that predicted end-of-day time. Each scheduled job carries `meta`
  (who/when, in local time) so it's inspectable without decoding
  `scheduled_at`/`args` by hand.

  Mirrored by `Manfrod.Workers.FirmowidMorningReminderSchedulerWorker` for
  the start-of-day side.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.Accounts
  alias Manfrod.Firmowid.SessionStats
  alias Manfrod.Mcp
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
    run(DateTime.now!(@timezone))
    :ok
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
         {:ok, sessions} <-
           SessionStats.fetch_recent_sessions(
             provider.mcp_url,
             access_token,
             @session_sample_size
           ),
         {:ok, avg_time} <-
           SessionStats.average_time_of_day(sessions, today, "end_datetime", :max) do
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

  defp schedule_reminder(user_id, date, avg_time) do
    reminder_at_local =
      date
      |> DateTime.new!(avg_time, @timezone)
      |> DateTime.add(@offset_minutes * 60, :second)

    reminder_at = DateTime.shift_zone!(reminder_at_local, "Etc/UTC")

    if DateTime.compare(reminder_at, DateTime.utc_now()) == :gt do
      args = %{user_id: user_id, date: Date.to_iso8601(date)}
      user = Accounts.get_user!(user_id)

      meta = %{
        user_id: user_id,
        user_name: user.name,
        user_email: user.email,
        avg_end_time: Time.to_iso8601(avg_time),
        scheduled_for_local: DateTime.to_iso8601(reminder_at_local)
      }

      case FirmowidSessionCheckWorker.new(args,
             scheduled_at: reminder_at,
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
      "FirmowidReminderSchedulerWorker: failed to schedule check for #{user_id}: #{inspect(reason)}"
    )

    0
  end
end
