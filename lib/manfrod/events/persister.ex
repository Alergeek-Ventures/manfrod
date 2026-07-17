defmodule Manfrod.Events.Persister do
  @moduledoc """
  GenServer that subscribes to agent activity and persists events.

  Handles periodic cleanup with different retention periods:
  - Log events: 24 hours
  - All other events: 7 days
  """
  use GenServer

  require Logger

  alias Manfrod.Events
  alias Manfrod.Events.Activity
  alias Manfrod.Events.Store

  @event_retention_days 7
  @log_retention_hours 24
  @cleanup_interval :timer.hours(1)

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Events.subscribe_global()
    schedule_cleanup()
    Logger.info("Events.Persister started, subscribed to global activity events")
    {:ok, %{}}
  end

  @impl true
  def handle_info({:activity, %Activity{} = activity}, state) do
    persist(activity)
    {:noreply, state}
  end

  def handle_info(:cleanup, state) do
    # Clean up logs (24 hour retention)
    {log_count, _} = Store.delete_logs_older_than(@log_retention_hours)

    # Clean up other events (7 day retention)
    {event_count, _} = Store.delete_older_than(@event_retention_days)

    total = log_count + event_count

    if total > 0 do
      Logger.info(
        "Cleaned up #{total} events (#{log_count} logs >#{@log_retention_hours}h, #{event_count} events >#{@event_retention_days}d)"
      )
    end

    schedule_cleanup()
    {:noreply, state}
  end

  # The audit log must never take down the event bus (or, via supervisor
  # restart intensity, the whole app). A DB failure here just drops the
  # event: connection loss, and — under the test sandbox — a checkout
  # exiting because the owning test finished mid-insert (an exit signal,
  # which `rescue` alone would not catch).
  defp persist(activity) do
    case Store.insert(activity) do
      {:ok, _event} ->
        :ok

      {:error, changeset} ->
        Logger.warning("Failed to persist activity: #{inspect(changeset.errors)}")
    end
  rescue
    error in [DBConnection.OwnershipError, DBConnection.ConnectionError] ->
      Logger.warning("Failed to persist activity: #{Exception.message(error)}")
  catch
    :exit, reason ->
      Logger.warning("Failed to persist activity: #{inspect(reason)}")
  end

  defp schedule_cleanup do
    Process.send_after(self(), :cleanup, @cleanup_interval)
  end
end
