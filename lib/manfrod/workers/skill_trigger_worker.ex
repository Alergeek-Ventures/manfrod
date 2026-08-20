defmodule Manfrod.Workers.SkillTriggerWorker do
  @moduledoc """
  Executes a scheduled (cron) skill run. Scheduled by
  `Manfrod.Workers.SkillSchedulerWorker` for any skill declaring a `cron`
  field in its frontmatter, for any skill name — there's no per-skill code
  here. `Manfrod.SkillRunner` loads the skill's SKILL.md body and lets the
  normal agent tool set act on it autonomously, the same as if a user had
  typed those instructions.

  A `scope: "channel"` cron-skill (the default) has no owning user — its
  `channel` frontmatter field says where the run's tool calls and final
  reply land, same as `Manfrod.Workers.TriggerWorker` targets a fixed
  channel rather than a user. A `scope: "user"` cron-skill instead carries
  a `user_id` in its args (one job per connected user, scheduled by
  `SkillSchedulerWorker`) and runs scoped to that real user, posting to
  their Slack DM.

  ## Job args
  - `skill_name` - name of the cron-skill to run (matches a `priv/skills/<name>/` folder)
  - `user_id` - optional; present only for `scope: "user"` cron-skills
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"skill_name" => skill_name, "user_id" => user_id}}) do
    Manfrod.SkillRunner.run(skill_name, user_id: user_id)
  end

  def perform(%Oban.Job{args: %{"skill_name" => skill_name}}) do
    Manfrod.SkillRunner.run(skill_name)
  end
end
