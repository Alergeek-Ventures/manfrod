defmodule Manfrod.Workers.FirmowidSessionCheckWorker do
  @moduledoc """
  Runs a single scheduled Firmowid forgotten-session check for one user, via
  `Manfrod.SkillRunner` (same mechanism as any cron-skill — supports the
  `EMPTY` sentinel so a still-normal session posts nothing).

  Scheduled by `Manfrod.Workers.FirmowidReminderSchedulerWorker` at a time
  computed from that user's own session history, not a fixed schedule —
  deliberately a distinct worker rather than a `Manfrod.Workers.SkillTriggerWorker`
  job, since those get swept on every deploy by
  `Manfrod.Release.reset_skill_schedule/0` (which would otherwise silently
  drop today's already-computed check on a deploy landing between 9am and
  the scheduled time).
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  @skill_name "firmowid-session-check"

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"user_id" => user_id}}) do
    Manfrod.SkillRunner.run(@skill_name, user_id: user_id)
  end
end
