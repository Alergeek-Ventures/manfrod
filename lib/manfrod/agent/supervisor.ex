defmodule Manfrod.Agent.Supervisor do
  @moduledoc """
  Supervises per-user Agent processes.

  Uses a Registry for naming and a DynamicSupervisor for on-demand
  process creation. Agent processes are `:temporary` — they are not
  restarted when they terminate normally (idle timeout). The next
  message for that user starts a fresh process.
  """

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children = [
      {Registry, keys: :unique, name: Manfrod.Agent.Registry},
      {DynamicSupervisor, strategy: :one_for_one, name: Manfrod.Agent.DynamicSupervisor}
    ]

    Supervisor.init(children, strategy: :one_for_all)
  end
end
