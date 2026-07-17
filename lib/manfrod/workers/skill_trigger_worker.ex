defmodule Manfrod.Workers.SkillTriggerWorker do
  @moduledoc """
  Executes a scheduled (cron) skill run, dispatching by skill name to its
  runner module. Scheduled by `Manfrod.Workers.SkillSchedulerWorker` for any
  skill declaring a `cron` field in its frontmatter.

  No cron-skills exist yet — this is the extension point for future
  scheduled skills: add a `perform/1` clause matching the skill's name (or a
  generic agent runner) and give the skill a `cron:` frontmatter field.

  Unlike `Manfrod.Workers.TriggerWorker` (recurring reminders, which always
  DM a specific user), a cron-skill has no owning user — each runner decides
  for itself what "running the skill" means.

  ## Job args
  - `skill_name` - name of the cron-skill to run (matches a `priv/skills/<name>/`
    folder and a case clause below)
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"skill_name" => skill_name}}) do
    Logger.warning("SkillTriggerWorker: no runner registered for skill '#{skill_name}', skipping")
    :ok
  end
end
