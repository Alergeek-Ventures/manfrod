defmodule Manfrod.Workers.TriggerWorker do
  @moduledoc """
  Executes a scheduled trigger by sending a prompt to the Agent via Proactive.

  Proactive creates a new DM thread for the user and routes the Agent's
  response there. The user sees the response and can reply to continue.

  ## Job args

  For recurring reminders (from SchedulerWorker):
  - `recurring_reminder_id` - UUID of the recurring reminder
  - `user_id` - UUID of the user who owns the reminder

  For one-time reminders (from Agent):
  - `trigger_id` - identifier of the trigger (for logging)
  - `prompt` - the message to send to the Agent
  - `user_id` - UUID of the user
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.Memory
  alias Manfrod.Proactive

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"recurring_reminder_id" => reminder_id, "user_id" => user_id}}) do
    Logger.info(
      "TriggerWorker: executing recurring reminder '#{reminder_id}' for user #{user_id}"
    )

    case Memory.get_recurring_reminder(user_id, reminder_id) do
      nil ->
        Logger.warning("TriggerWorker: recurring reminder '#{reminder_id}' not found, skipping")
        :ok

      reminder ->
        if reminder.enabled do
          prompt = build_recurring_reminder_prompt(reminder)
          send_proactive(user_id, prompt, "recurring:#{reminder.name}")
        else
          Logger.info(
            "TriggerWorker: recurring reminder '#{reminder.name}' is disabled, skipping"
          )

          :ok
        end
    end
  end

  def perform(%Oban.Job{
        args: %{"prompt" => prompt, "trigger_id" => trigger_id, "user_id" => user_id}
      }) do
    Logger.info("TriggerWorker: executing one-time trigger '#{trigger_id}' for user #{user_id}")
    send_proactive(user_id, prompt, trigger_id)
  end

  defp send_proactive(user_id, prompt, trigger_id) do
    case Proactive.send(user_id, prompt) do
      :ok ->
        Logger.info(
          "TriggerWorker: trigger '#{trigger_id}' sent via Proactive for user #{user_id}"
        )

        :ok

      {:error, reason} ->
        Logger.error(
          "TriggerWorker: failed to send trigger '#{trigger_id}' for user #{user_id}: #{inspect(reason)}"
        )

        {:error, reason}
    end
  end

  defp build_recurring_reminder_prompt(reminder) do
    node = reminder.node
    linked_nodes = Memory.get_node_links(reminder.user_id, node.id)

    linked_section =
      if linked_nodes == [] do
        ""
      else
        linked_items =
          linked_nodes
          |> Enum.map(fn n -> "- [#{n.id}] #{n.content}" end)
          |> Enum.join("\n")

        """

        ---
        Linked notes:
        #{linked_items}
        """
      end

    """
    [Recurring Reminder: #{reminder.name}]

    #{node.content}#{linked_section}
    """
    |> String.trim()
  end
end
