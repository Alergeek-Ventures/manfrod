defmodule Manfrod.Tools.Reminders do
  @moduledoc """
  One-time and recurring reminder tools for the live agent.
  """

  alias Manfrod.Memory
  alias Manfrod.Workers.TriggerWorker

  def definitions(%{user_id: user_id}) do
    [
      ReqLLM.Tool.new!(
        name: "set_reminder",
        description:
          "Schedule a reminder for yourself at a specific time. You will receive the message as a new conversation.",
        parameter_schema: [
          message: [type: :string, required: true, doc: "What to remind yourself about"],
          at: [
            type: :string,
            required: true,
            doc: "When to trigger (ISO8601 UTC datetime, e.g., '2026-02-04T14:00:00Z')"
          ]
        ],
        callback: fn args -> set_reminder(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_reminders",
        description: "List all pending reminders you have scheduled.",
        parameter_schema: [],
        callback: fn args -> list_reminders(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "cancel_reminder",
        description: "Cancel a pending reminder by its job ID.",
        parameter_schema: [
          id: [type: :integer, required: true, doc: "The job ID of the reminder to cancel"]
        ],
        callback: &cancel_reminder/1
      ),
      ReqLLM.Tool.new!(
        name: "create_recurring_reminder",
        description:
          "Create a recurring reminder that triggers on a cron schedule. Requires a note to be linked - the note content becomes the prompt.",
        parameter_schema: [
          name: [
            type: :string,
            required: true,
            doc: "Unique identifier for the reminder (e.g., 'morning_brief', 'weekly_review')"
          ],
          cron: [
            type: :string,
            required: true,
            doc:
              "Cron expression (5 fields: minute hour day-of-month month day-of-week). Examples: '0 8 * * *' (daily at 8:00), '0 9 * * 1' (Mondays at 9:00)"
          ],
          node_id: [
            type: :string,
            required: true,
            doc: "UUID of the note containing instructions for this reminder"
          ],
          timezone: [
            type: :string,
            doc: "IANA timezone (default: 'Europe/Warsaw'). Examples: 'UTC', 'America/New_York'"
          ]
        ],
        callback: fn args -> create_recurring_reminder(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_recurring_reminders",
        description: "List all recurring reminders with their schedules and linked notes.",
        parameter_schema: [],
        callback: fn args -> list_recurring_reminders(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "update_recurring_reminder",
        description:
          "Update a recurring reminder. Can change cron schedule, linked note, timezone, or enabled status.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "UUID of the recurring reminder to update"],
          cron: [type: :string, doc: "New cron expression"],
          node_id: [type: :string, doc: "UUID of new note to link"],
          timezone: [type: :string, doc: "New timezone"],
          enabled: [type: :boolean, doc: "Enable/disable the reminder"]
        ],
        callback: fn args -> update_recurring_reminder(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "delete_recurring_reminder",
        description:
          "Delete a recurring reminder. All pending scheduled jobs for this reminder are cancelled.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "UUID of the recurring reminder to delete"]
        ],
        callback: fn args -> delete_recurring_reminder(user_id, args) end
      )
    ]
  end

  defp set_reminder(user_id, %{message: message, at: at_string}) do
    with {:ok, scheduled_at, _offset} <- DateTime.from_iso8601(at_string),
         :gt <- DateTime.compare(scheduled_at, DateTime.utc_now()),
         args = %{
           prompt: "[Reminder] #{message}",
           trigger_id: "reminder_#{:erlang.phash2({message, scheduled_at})}",
           user_id: user_id
         },
         {:ok, job} <- TriggerWorker.new(args, scheduled_at: scheduled_at) |> Oban.insert() do
      {:ok, "Reminder set (job ##{job.id}) for #{scheduled_at}: #{message}"}
    else
      {:error, _} -> {:ok, "Invalid datetime. Use ISO8601 UTC like '2026-02-04T14:00:00Z'"}
      :lt -> {:ok, "Cannot set reminder in the past. Provide a future datetime."}
      :eq -> {:ok, "Cannot set reminder in the past. Provide a future datetime."}
    end
  end

  defp list_reminders(user_id, _args) do
    import Ecto.Query

    jobs =
      Oban.Job
      |> where([j], j.worker == "Manfrod.Workers.TriggerWorker")
      |> where([j], j.state in ["scheduled", "available"])
      |> where([j], fragment("?->>'trigger_id' LIKE 'reminder_%'", j.args))
      |> where([j], fragment("?->>'user_id' = ?", j.args, ^user_id))
      |> order_by([j], asc: j.scheduled_at)
      |> Manfrod.Repo.all()

    if Enum.empty?(jobs) do
      {:ok, "No pending reminders."}
    else
      lines =
        Enum.map(jobs, fn job ->
          message = String.replace_prefix(job.args["prompt"], "[Reminder] ", "")
          "• ##{job.id} at #{job.scheduled_at}: #{message}"
        end)

      {:ok, "Pending reminders:\n#{Enum.join(lines, "\n")}"}
    end
  end

  defp cancel_reminder(%{id: job_id}) do
    :ok = Oban.cancel_job(job_id)
    {:ok, "Reminder ##{job_id} cancelled."}
  end

  defp create_recurring_reminder(user_id, args) do
    attrs = %{
      name: args.name,
      cron: args.cron,
      node_id: args.node_id,
      timezone: Map.get(args, :timezone, "Europe/Warsaw")
    }

    case Memory.create_recurring_reminder(user_id, attrs) do
      {:ok, reminder} ->
        {:ok,
         "Created recurring reminder '#{reminder.name}' with cron '#{reminder.cron}' (#{reminder.timezone}). Linked to note: #{reminder.node_id}"}

      {:error, changeset} ->
        errors =
          Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
            Enum.reduce(opts, msg, fn {key, value}, acc ->
              String.replace(acc, "%{#{key}}", to_string(value))
            end)
          end)

        {:ok, "Failed to create recurring reminder: #{inspect(errors)}"}
    end
  end

  defp list_recurring_reminders(user_id, _args) do
    reminders = Memory.list_recurring_reminders(user_id)

    if Enum.empty?(reminders) do
      {:ok, "No recurring reminders configured."}
    else
      lines =
        Enum.map(reminders, fn r ->
          status = if r.enabled, do: "enabled", else: "disabled"
          note_preview = String.slice(r.node.content || "", 0, 50)

          "• #{r.name} (#{r.id})\n  Cron: #{r.cron} (#{r.timezone})\n  Status: #{status}\n  Note: [#{r.node_id}] #{note_preview}..."
        end)

      {:ok, "Recurring reminders:\n\n#{Enum.join(lines, "\n\n")}"}
    end
  end

  defp update_recurring_reminder(user_id, %{id: id} = args) do
    case Memory.get_recurring_reminder(user_id, id) do
      nil ->
        {:ok, "Recurring reminder not found: #{id}"}

      reminder ->
        attrs =
          args
          |> Map.drop([:id])
          |> Enum.reject(fn {_k, v} -> is_nil(v) end)
          |> Map.new()

        case Memory.update_recurring_reminder(user_id, reminder, attrs) do
          {:ok, updated} ->
            {:ok, "Updated recurring reminder '#{updated.name}'"}

          {:error, changeset} ->
            errors =
              Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
                Enum.reduce(opts, msg, fn {key, value}, acc ->
                  String.replace(acc, "%{#{key}}", to_string(value))
                end)
              end)

            {:ok, "Failed to update recurring reminder: #{inspect(errors)}"}
        end
    end
  end

  defp delete_recurring_reminder(user_id, %{id: id}) do
    case Memory.delete_recurring_reminder(user_id, id) do
      {:ok, reminder} ->
        {:ok, "Deleted recurring reminder '#{reminder.name}' and cancelled all pending jobs."}

      {:error, :not_found} ->
        {:ok, "Recurring reminder not found: #{id}"}
    end
  end
end
