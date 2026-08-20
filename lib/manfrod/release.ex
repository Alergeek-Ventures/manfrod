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
  stale instructions. Safe and lossless either way:
  `Manfrod.Workers.SkillSchedulerWorker` (hourly) fully regenerates the
  correct set from the current skill files on its next tick — nothing here
  is a durable source of truth being discarded.
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

          {:ok, repo.delete_all(query)}
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
