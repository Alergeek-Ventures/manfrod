defmodule Manfrod.Workers.RetrospectionWorker do
  @moduledoc """
  Oban worker that triggers retrospection every hour.

  Iterates all pending slipbox nodes grouped by access bucket and runs
  the Retrospector agent for each bucket independently.
  """
  use Oban.Worker,
    queue: :retrospection,
    max_attempts: 3

  require Logger

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    :ok = Manfrod.Memory.Retrospector.process_all_buckets()
    Logger.info("RetrospectionWorker: completed")
    :ok
  end
end
