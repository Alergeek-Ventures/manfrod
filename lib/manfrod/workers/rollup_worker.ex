defmodule Manfrod.Workers.RollupWorker do
  @moduledoc """
  Rolls raw audit events up into the daily analytics tables.

  Runs hourly so the current day's numbers stay fresh on the analytics page,
  and re-runs a multi-day lookback window each time. The window matters: raw
  events are purged after 7 days, so a few missed runs (deploy, downtime) would
  otherwise lose that history permanently. Recomputing is idempotent, so the
  overlap costs nothing but a few extra upserts.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3,
    # An hourly cron job that is still queued an hour later has been superseded
    # by the next one — the lookback window makes the skipped run a no-op.
    unique: [period: 3_600]

  require Logger

  alias Manfrod.Analytics.Rollup

  # Comfortably inside the 7-day raw retention, with room for a long outage.
  @lookback_days 4

  @impl Oban.Worker
  def perform(%Oban.Job{args: args}) do
    days = Map.get(args, "days", @lookback_days)

    Rollup.run_recent(days)

    Logger.info("RollupWorker: rolled up the last #{days} day(s)")
    :ok
  end
end
