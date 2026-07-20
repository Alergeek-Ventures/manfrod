defmodule Manfrod.Workers.GraphReviewWorker do
  @moduledoc """
  Oban worker that triggers a deep review of the already-integrated graph
  every 2 days (see the cron entry in `config/config.exs`), independent of
  the weekly slipbox-drain done by `Manfrod.Workers.RetrospectionWorker`.
  """
  use Oban.Worker,
    queue: :retrospection,
    max_attempts: 3

  require Logger

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    :ok = Manfrod.Memory.Retrospector.review_processed_graph()
    Logger.info("GraphReviewWorker: completed")
    :ok
  end
end
