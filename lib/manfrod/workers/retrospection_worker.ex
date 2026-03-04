defmodule Manfrod.Workers.RetrospectionWorker do
  @moduledoc """
  Oban worker that triggers retrospection every hour.

  Iterates all users that have unprocessed slipbox nodes and runs
  the Retrospector agent for each one independently.
  """
  use Oban.Worker,
    queue: :retrospection,
    max_attempts: 3

  require Logger

  alias Manfrod.Accounts

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    user_ids = Accounts.user_ids_with_slipbox_nodes()

    if user_ids == [] do
      Logger.debug("RetrospectionWorker: no users with slipbox nodes")
      :ok
    else
      Logger.info("RetrospectionWorker: running retrospection for #{length(user_ids)} user(s)")

      errors =
        Enum.flat_map(user_ids, fn user_id ->
          case Manfrod.Memory.Retrospector.process_slipbox(user_id) do
            :ok ->
              Logger.info("RetrospectionWorker: retrospection completed for user #{user_id}")
              []

            {:error, reason} ->
              Logger.error(
                "RetrospectionWorker: retrospection failed for user #{user_id}: #{inspect(reason)}"
              )

              [{user_id, reason}]
          end
        end)

      if errors == [] do
        :ok
      else
        {:error, "Failed for #{length(errors)} user(s): #{inspect(errors)}"}
      end
    end
  end
end
