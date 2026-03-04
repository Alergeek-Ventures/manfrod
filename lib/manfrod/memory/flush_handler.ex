defmodule Manfrod.Memory.FlushHandler do
  @moduledoc """
  Handles memory extraction on conversation idle.

  Subscribes to the global event bus and triggers per-user extraction
  when any Agent broadcasts an :idle event. The Extractor fetches
  pending messages for that user from the database.
  """
  use GenServer

  require Logger

  alias Manfrod.Events
  alias Manfrod.Events.Activity
  alias Manfrod.Memory.Extractor

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Events.subscribe_global()
    {:ok, %{}}
  end

  @impl true
  def handle_info(
        {:activity, %Activity{type: :idle, user_id: user_id, session_key: session_key}},
        state
      )
      when is_binary(user_id) and is_binary(session_key) do
    Logger.info(
      "FlushHandler: idle detected for user #{user_id}, session #{session_key}, triggering extraction"
    )

    Extractor.extract_async(user_id, session_key)
    {:noreply, state}
  end

  def handle_info({:activity, %Activity{}}, state) do
    # Ignore other event types or events without user_id
    {:noreply, state}
  end
end
