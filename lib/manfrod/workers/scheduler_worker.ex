defmodule Manfrod.Workers.SchedulerWorker do
  @moduledoc """
  Runs hourly via Oban cron. Reads recurring reminders from the database
  and idempotently schedules `TriggerWorker` jobs for the next 12 hours.

  Iterates all enabled recurring reminders across all users.

  ## How it works

  1. Reads all enabled recurring reminders from `Manfrod.Memory`
  2. For each reminder, calculates the next occurrences within 12 hours using cron expression
  3. Inserts `TriggerWorker` jobs with Oban's uniqueness constraint
  4. Duplicate jobs (same recurring_reminder_id + scheduled_at) are skipped automatically

  ## Timezone handling

  Each reminder has its own timezone (default Europe/Warsaw). This worker converts
  to UTC when scheduling, handling DST transitions automatically.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.Workers.TriggerWorker

  @schedule_window_hours 12

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    Logger.info("SchedulerWorker: scheduling triggers for next #{@schedule_window_hours} hours")

    now = DateTime.utc_now()

    # Query all enabled reminders across all users
    reminders = all_enabled_reminders()

    scheduled_count =
      for reminder <- reminders,
          scheduled_at <- next_occurrences(reminder, now),
          reduce: 0 do
        count ->
          args = %{
            recurring_reminder_id: reminder.id,
            user_id: reminder.user_id,
            # scheduled_at is included in args for uniqueness checking.
            # Oban's unique keys refer to args fields, not job fields.
            scheduled_at: DateTime.to_iso8601(scheduled_at)
          }

          case TriggerWorker.new(args,
                 scheduled_at: scheduled_at,
                 unique: [
                   period: @schedule_window_hours * 3600,
                   keys: [:recurring_reminder_id, :scheduled_at]
                 ]
               )
               |> Oban.insert() do
            {:ok, %{conflict?: false}} ->
              Logger.debug("SchedulerWorker: scheduled #{reminder.name} for #{scheduled_at}")
              count + 1

            {:ok, %{conflict?: true}} ->
              Logger.debug(
                "SchedulerWorker: #{reminder.name} at #{scheduled_at} already scheduled"
              )

              count

            {:error, reason} ->
              Logger.error(
                "SchedulerWorker: failed to schedule #{reminder.name}: #{inspect(reason)}"
              )

              count
          end
      end

    Logger.info("SchedulerWorker: scheduled #{scheduled_count} new trigger jobs")
    :ok
  end

  # Query all enabled reminders across all users (no user_id filter)
  defp all_enabled_reminders do
    import Ecto.Query

    Manfrod.Memory.RecurringReminder
    |> where([r], r.enabled == true)
    |> order_by([r], asc: r.name)
    |> Manfrod.Repo.all()
  end

  @doc """
  Calculates the next occurrences of a cron schedule within the scheduling window.

  Returns a list of UTC DateTimes for the reminder to fire.
  """
  @spec next_occurrences(Manfrod.Memory.RecurringReminder.t(), DateTime.t()) :: [DateTime.t()]
  def next_occurrences(reminder, now) do
    case Crontab.CronExpression.Parser.parse(reminder.cron) do
      {:ok, cron_expr} ->
        now_local = DateTime.shift_zone!(now, reminder.timezone)
        window_end = DateTime.add(now, @schedule_window_hours, :hour)

        # Get stream of next occurrences (in local time, as NaiveDateTime)
        cron_expr
        |> Crontab.Scheduler.get_next_run_dates(DateTime.to_naive(now_local))
        |> Stream.map(fn naive_dt ->
          # Convert back to DateTime in the reminder's timezone, then to UTC
          DateTime.from_naive!(naive_dt, reminder.timezone)
          |> DateTime.shift_zone!("Etc/UTC")
        end)
        |> Stream.take_while(fn dt -> DateTime.compare(dt, window_end) != :gt end)
        |> Enum.to_list()

      {:error, reason} ->
        Logger.error(
          "SchedulerWorker: invalid cron expression for #{reminder.name}: #{inspect(reason)}"
        )

        []
    end
  end
end
