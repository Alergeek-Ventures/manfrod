defmodule Manfrod.Workers.GitleaksRulesRefreshWorker do
  @moduledoc """
  Refreshes `Manfrod.Security.GitleaksRules`' cached secret-pattern ruleset
  from upstream daily (see the cron entry in `config/config.exs`). Keeps the
  last good ruleset on any fetch/parse failure.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  alias Manfrod.Security.GitleaksRules

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    GitleaksRules.refresh()
    :ok
  end
end
