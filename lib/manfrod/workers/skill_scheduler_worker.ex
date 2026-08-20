defmodule Manfrod.Workers.SkillSchedulerWorker do
  @moduledoc """
  Runs hourly via Oban cron. Reads skills that declare a `cron` field in
  their frontmatter (`Manfrod.Skills.list_cron_skills/0`) and idempotently
  schedules `SkillTriggerWorker` jobs.

  Mirrors `Manfrod.Workers.SchedulerWorker` (recurring reminders), but for
  cron-skills instead of per-user reminders — cron-skills have no owning
  user and no per-skill timezone, so a fixed timezone is used for all of
  them.

  Two schedule shapes:
  - Standard 5-field cron (`{:standard, cron_expr}` from `parse_cron/1`) —
    every future occurrence in the next `@schedule_window_hours` gets its
    own trigger job, deduped by `{skill_name, scheduled_at}` since the
    occurrence is deterministic.
  - `RAND(HH:MM-HH:MM) <dom> <month> <dow>` (`{:random, ...}`) — for each
    matching calendar day (today/tomorrow, Europe/Warsaw) whose window
    hasn't closed yet, ONE random instant inside the window is drawn and
    frozen via Oban uniqueness keyed WITHOUT `scheduled_at` (`{skill_name,
    date}`, or `{skill_name, user_id, date}` for `scope: "user"`) — so a
    later run of this same hourly worker, before or after the job fires,
    can never re-roll or duplicate that day's draw. `states:` explicitly
    includes `:completed`/`:cancelled`/`:discarded` because Oban's default
    unique states exclude those — without this, a later run this same day
    would see the (by-then-completed) job as non-blocking and draw a
    second, different random time for the same day.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.Mcp
  alias Manfrod.Skills
  alias Manfrod.Workers.SkillTriggerWorker

  @schedule_window_hours 12
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
    Logger.info("SkillSchedulerWorker: scheduling cron-skill triggers")

    now = DateTime.utc_now()
    cron_skills = Skills.list_cron_skills()

    scheduled_count =
      Enum.reduce(cron_skills, 0, fn skill, count -> count + schedule(skill, now) end)

    Logger.info("SkillSchedulerWorker: scheduled #{scheduled_count} new trigger job(s)")
    :ok
  end

  @doc """
  Parses a cron-skill's `cron` field.

  A plain 5-field cron string parses as `{:standard, %Crontab.CronExpression{}}`,
  same as always. A `RAND(HH:MM-HH:MM) <dom> <month> <dow>` fusion parses as
  `{:random, start_time, end_time, date_condition_list}` — `start_time`/
  `end_time` are `Time` structs, and `date_condition_list` is the
  day-of-month/month/day-of-week subset of the trailing 3 fields (parsed via
  the standard `Crontab` parser, since those fields keep their standard
  cron semantics — lists/ranges/steps/`*`), suitable for
  `Crontab.DateChecker.matches_date?/2`.

  Returns `:error` for anything unparseable.
  """
  @spec parse_cron(String.t()) ::
          {:standard, Crontab.CronExpression.t()}
          | {:random, Time.t(), Time.t(), Crontab.CronExpression.condition_list()}
          | :error
  def parse_cron(cron) do
    case Regex.run(~r/^RAND\((\d{2}:\d{2})-(\d{2}:\d{2})\)\s+(.+)$/, cron || "") do
      [_, start_str, end_str, rest] -> parse_random_cron(start_str, end_str, rest)
      nil -> parse_standard_cron(cron)
    end
  end

  defp parse_random_cron(start_str, end_str, rest) do
    with {:ok, start_t} <- Time.from_iso8601(start_str <> ":00"),
         {:ok, end_t} <- Time.from_iso8601(end_str <> ":00"),
         {:ok, cron_expr} <- Crontab.CronExpression.Parser.parse("0 0 " <> rest) do
      date_conditions =
        cron_expr
        |> Crontab.CronExpression.to_condition_list()
        |> Enum.filter(fn {field, _} -> field in [:day, :month, :weekday] end)

      {:random, start_t, end_t, date_conditions}
    else
      _ -> :error
    end
  end

  defp parse_standard_cron(cron) do
    case Crontab.CronExpression.Parser.parse(cron) do
      {:ok, cron_expr} -> {:standard, cron_expr}
      {:error, _} -> :error
    end
  end

  defp schedule(skill, now) do
    case parse_cron(skill.cron) do
      {:standard, _} ->
        schedule_standard(skill, now)

      {:random, start_t, end_t, date_conditions} ->
        schedule_random(skill, start_t, end_t, date_conditions, now)

      :error ->
        Logger.error("SkillSchedulerWorker: invalid cron expression for #{skill.name}")
        0
    end
  end

  defp schedule_standard(skill, now) do
    for scheduled_at <- next_occurrences(skill, now), reduce: 0 do
      count ->
        args = %{
          skill_name: skill.name,
          # scheduled_at is included in args for uniqueness checking.
          scheduled_at: DateTime.to_iso8601(scheduled_at)
        }

        insert_trigger(
          skill.name,
          args,
          scheduled_at,
          unique: [period: @schedule_window_hours * 3600, keys: [:skill_name, :scheduled_at]]
        ) + count
    end
  end

  defp schedule_random(skill, start_t, end_t, date_conditions, now) do
    now_local = DateTime.shift_zone!(now, @timezone)
    today = DateTime.to_date(now_local)
    tomorrow = Date.add(today, 1)

    for date <- [today, tomorrow],
        matches_date?(date_conditions, date),
        reduce: 0 do
      count -> count + schedule_random_for_date(skill, date, start_t, end_t, now_local)
    end
  end

  defp matches_date?(date_conditions, date) do
    Crontab.DateChecker.matches_date?(date_conditions, NaiveDateTime.new!(date, ~T[00:00:00]))
  end

  defp schedule_random_for_date(skill, date, start_t, end_t, now_local) do
    window_end = DateTime.new!(date, end_t, @timezone)

    if DateTime.compare(now_local, window_end) == :lt do
      case skill.scope do
        "user" -> schedule_random_for_users(skill, date, start_t, end_t)
        _ -> schedule_random_once(skill, date, start_t, end_t, nil)
      end
    else
      0
    end
  end

  defp schedule_random_for_users(skill, date, start_t, end_t) do
    if is_binary(skill.requires_mcp) do
      skill.requires_mcp
      |> Mcp.list_connections_for_provider()
      |> Enum.reduce(0, fn conn, count ->
        count + schedule_random_once(skill, date, start_t, end_t, conn.user_id)
      end)
    else
      Logger.error("SkillSchedulerWorker: #{skill.name} has scope: user but no requires_mcp")
      0
    end
  end

  defp schedule_random_once(skill, date, start_t, end_t, user_id) do
    instant = random_instant(date, start_t, end_t)
    args = %{skill_name: skill.name, date: Date.to_iso8601(date)}
    args = if user_id, do: Map.put(args, :user_id, user_id), else: args
    keys = if user_id, do: [:skill_name, :user_id, :date], else: [:skill_name, :date]

    insert_trigger(skill.name, args, instant, unique: [keys: keys, states: @unique_states])
  end

  defp random_instant(date, start_t, end_t) do
    start_dt = DateTime.new!(date, start_t, @timezone)
    end_dt = DateTime.new!(date, end_t, @timezone)
    span_seconds = max(DateTime.diff(end_dt, start_dt, :second), 1)
    offset = :rand.uniform(span_seconds) - 1

    start_dt
    |> DateTime.add(offset, :second)
    |> DateTime.shift_zone!("Etc/UTC")
  end

  defp insert_trigger(skill_name, args, scheduled_at, opts) do
    case SkillTriggerWorker.new(args, [scheduled_at: scheduled_at] ++ opts) |> Oban.insert() do
      {:ok, %{conflict?: false}} ->
        Logger.debug("SkillSchedulerWorker: scheduled #{skill_name} for #{scheduled_at}")
        1

      {:ok, %{conflict?: true}} ->
        0

      {:error, reason} ->
        Logger.error("SkillSchedulerWorker: failed to schedule #{skill_name}: #{inspect(reason)}")
        0
    end
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
