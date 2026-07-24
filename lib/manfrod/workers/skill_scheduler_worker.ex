defmodule Manfrod.Workers.SkillSchedulerWorker do
  @moduledoc """
  Runs hourly via Oban cron. Reads skills that declare a `cron` field in
  their frontmatter (`Manfrod.Skills.list_cron_skills/0`) and idempotently
  schedules `SkillTriggerWorker` jobs for the next 12 hours.

  Mirrors `Manfrod.Workers.SchedulerWorker` (recurring reminders), but for
  cron-skills instead of per-user reminders — cron-skills have no owning
  user and no per-skill timezone, so a fixed timezone is used for all of
  them.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.Skills
  alias Manfrod.Workers.SkillTriggerWorker

  @schedule_window_hours 12
  @timezone "Europe/Warsaw"

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    Logger.info(
      "SkillSchedulerWorker: scheduling cron-skill triggers for next #{@schedule_window_hours} hours"
    )

    now = DateTime.utc_now()
    cron_skills = Skills.list_cron_skills()

    scheduled_count =
      for skill <- cron_skills,
          scheduled_at <- next_occurrences(skill, now),
          reduce: 0 do
        count ->
          args = %{
            skill_name: skill.name,
            # scheduled_at is included in args for uniqueness checking.
            scheduled_at: DateTime.to_iso8601(scheduled_at)
          }

          case SkillTriggerWorker.new(args,
                 scheduled_at: scheduled_at,
                 unique: [
                   period: @schedule_window_hours * 3600,
                   keys: [:skill_name, :scheduled_at]
                 ]
               )
               |> Oban.insert() do
            {:ok, %{conflict?: false}} ->
              Logger.debug("SkillSchedulerWorker: scheduled #{skill.name} for #{scheduled_at}")
              count + 1

            {:ok, %{conflict?: true}} ->
              count

            {:error, reason} ->
              Logger.error(
                "SkillSchedulerWorker: failed to schedule #{skill.name}: #{inspect(reason)}"
              )

              count
          end
      end

    Logger.info("SkillSchedulerWorker: scheduled #{scheduled_count} new trigger job(s)")
    :ok
  end

  @doc """
  Calculates the next occurrences of a cron-skill's schedule within the
  scheduling window. Returns a list of UTC DateTimes.
  """
  @spec next_occurrences(map(), DateTime.t()) :: [DateTime.t()]
  def next_occurrences(skill, now) do
    case Crontab.CronExpression.Parser.parse(skill.cron) do
      {:ok, cron_expr} ->
        now_local = DateTime.shift_zone!(now, @timezone)
        window_end = DateTime.add(now, @schedule_window_hours, :hour)

        cron_expr
        |> Crontab.Scheduler.get_next_run_dates(DateTime.to_naive(now_local))
        |> Stream.map(fn naive_dt ->
          DateTime.from_naive!(naive_dt, @timezone)
          |> DateTime.shift_zone!("Etc/UTC")
        end)
        |> Stream.take_while(fn dt -> DateTime.compare(dt, window_end) != :gt end)
        |> Enum.to_list()

      {:error, reason} ->
        Logger.error(
          "SkillSchedulerWorker: invalid cron expression for #{skill.name}: #{inspect(reason)}"
        )

        []
    end
  end
end
