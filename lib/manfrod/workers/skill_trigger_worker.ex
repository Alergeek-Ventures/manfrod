defmodule Manfrod.Workers.SkillTriggerWorker do
  @moduledoc """
  Executes a scheduled (cron) skill run. Scheduled by
  `Manfrod.Workers.SkillSchedulerWorker` for any skill declaring a `cron`
  field in its frontmatter, for any skill name — there's no per-skill code
  here. `Manfrod.SkillRunner` loads the skill's SKILL.md body and lets the
  normal agent tool set act on it autonomously, the same as if a user had
  typed those instructions.

  Unlike `Manfrod.Workers.TriggerWorker` (recurring reminders, which always
  DM a specific user), a cron-skill has no owning user — its `channel`
  frontmatter field says where the run's tool calls and final reply land.

  ## Job args
  - `skill_name` - name of the cron-skill to run (matches a `priv/skills/<name>/` folder)
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"skill_name" => skill_name}}) do
    Manfrod.SkillRunner.run(skill_name)
  end
end
