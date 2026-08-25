defmodule Manfrod.Release do
  @moduledoc """
  Used for executing DB release tasks when run in production without Mix
  installed.
  """
  import Ecto.Query

  @app :manfrod

  def migrate do
    load_app()

    for repo <- repos() do
      {:ok, _, _} = Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :up, all: true))
    end
  end

  @doc """
  Deletes not-yet-fired `Manfrod.Workers.SkillTriggerWorker` jobs (states
  `available`/`scheduled`), run once per deploy before the app starts
  serving. Cron-skills have no other source of truth than the current
  `priv/skills/*/SKILL.md` files, so any pending job scheduled under a
  since-changed or since-deleted skill would otherwise linger and fire on
  stale instructions.

  Also inserts one immediate `Manfrod.Workers.SkillSchedulerWorker` job
  right after the delete, so the schedule is regenerated as soon as the
  server's Oban queue starts processing — this step runs before the app
  (and Oban) is up, so without this the deleted schedule would otherwise
  sit empty until the next hourly cron tick, up to ~1h away. Inserting the
  job row directly (not `Oban.insert/1`, which needs a running Oban
  instance) is safe: it's the same DB row either way, just without the
  LISTEN/NOTIFY nudge for instant pickup.
  """
  def reset_skill_schedule do
    load_app()

    for repo <- repos() do
      {:ok, _, _} =
        Ecto.Migrator.with_repo(repo, fn repo ->
          query =
            from(j in Oban.Job,
              where: j.worker == "Manfrod.Workers.SkillTriggerWorker",
              where: j.state in ["available", "scheduled"]
            )

          deleted = repo.delete_all(query)
          {:ok, _job} = Manfrod.Workers.SkillSchedulerWorker.new(%{}) |> repo.insert()

          {:ok, deleted}
        end)
    end
  end

  def rollback(repo, version) do
    load_app()
    {:ok, _, _} = Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :down, to: version))
  end

  defp repos do
    Application.fetch_env!(@app, :ecto_repos)
  end

  defp load_app do
    Application.ensure_all_started(:ssl)
    Application.ensure_loaded(@app)
  end
end
