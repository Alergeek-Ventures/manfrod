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
        name: "schedule_followup_check",
        description:
          "Schedule a follow-up check for YOURSELF at a specific time — for when you (not " <>
            "the user) need to re-verify something later, e.g. checking back after being " <>
            "told 'still working' or 'not done yet'. Unlike set_reminder, this isn't a " <>
            "user-facing reminder: `instructions` is what you should actually do when it " <>
            "fires (call tools, decide whether there's anything worth saying), written as " <>
            "if telling your future self what to do — not as a message to relay verbatim.",
        parameter_schema: [
          instructions: [
            type: :string,
            required: true,
            doc: "Full instructions for that future turn — what to check and how to react"
          ],
          at: [
            type: :string,
            required: true,
            doc: "When to trigger (ISO8601 UTC datetime, e.g., '2026-02-04T14:00:00Z')"
          ]
        ],
        callback: fn args -> schedule_followup_check(user_id, args) end
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
          "Set up a task that runs itself on a recurring schedule, e.g. 'every day at 8 send me X' or 'every Monday check Y'. When it fires, the instructions become a full agent turn (same tools as a live chat), not just a text reminder.",
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
          instructions: [
            type: :string,
            required: true,
            doc:
              "Full instructions for what you should do each time this fires — written as if telling yourself what to do. This becomes the prompt for that future turn."
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
          "Update a recurring reminder. Can change the cron schedule, the instructions that run each time it fires, the timezone, or enabled status.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "UUID of the recurring reminder to update"],
          cron: [type: :string, doc: "New cron expression"],
          instructions: [
            type: :string,
            doc: "New instructions — replaces what runs when this fires"
          ],
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
           prompt: build_reminder_prompt(message),
           message: message,
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

  # Unlike set_reminder, the prompt is fired as-is — no "this is the user's
  # own reminder, relay it" framing — since the point is for a future turn
  # to actually act (re-run a check, decide whether to say anything), not
  # recite fixed text. Uses a distinct trigger_id prefix so it stays out of
  # list_reminders/cancel_reminder, which are user-facing.
  defp schedule_followup_check(user_id, %{instructions: instructions, at: at_string}) do
    with {:ok, scheduled_at, _offset} <- DateTime.from_iso8601(at_string),
         :gt <- DateTime.compare(scheduled_at, DateTime.utc_now()),
         args = %{
           prompt: instructions,
           trigger_id: "followup_#{:erlang.phash2({instructions, scheduled_at})}",
           user_id: user_id
         },
         {:ok, job} <- TriggerWorker.new(args, scheduled_at: scheduled_at) |> Oban.insert() do
      {:ok, "Follow-up check scheduled (job ##{job.id}) for #{scheduled_at}."}
    else
      {:error, _} -> {:ok, "Invalid datetime. Use ISO8601 UTC like '2026-02-04T14:00:00Z'"}
      :lt -> {:ok, "Cannot schedule a follow-up in the past. Provide a future datetime."}
      :eq -> {:ok, "Cannot schedule a follow-up in the past. Provide a future datetime."}
    end
  end

  defp build_reminder_prompt(message) do
    """
    [SYSTEM NOTICE — not a message from the user] The user scheduled the reminder \
    below for themselves, often phrased as a command to themselves (e.g. "Zrób \
    sobie przerwę"). That phrasing is addressed to THEM, not to you. Your only \
    job is to deliver it: send them a short natural message letting them know \
    it's time, referring to them in second person ("you"/"Ty"). Never respond \
    in first person as if you are the one taking the action (do not say things \
    like "I'll take a break" / "Robię sobie przerwę").

    Reminder text (written by the user, to the user): "#{message}"
    """
    |> String.trim()
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
          "• ##{job.id} at #{job.scheduled_at}: #{job.args["message"]}"
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
      instructions: args.instructions,
      timezone: Map.get(args, :timezone, "Europe/Warsaw")
    }

    case Memory.create_recurring_reminder(user_id, attrs) do
      {:ok, reminder} ->
        {:ok,
         "Created recurring reminder '#{reminder.name}' with cron '#{reminder.cron}' (#{reminder.timezone})."}

      {:error, changeset} ->
        {:ok, "Failed to create recurring reminder: #{format_changeset_errors(changeset)}"}
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

          "• #{r.name} (#{r.id})\n  Cron: #{r.cron} (#{r.timezone})\n  Status: #{status}\n  Instructions: #{r.instructions}"
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
            {:ok, "Failed to update recurring reminder: #{format_changeset_errors(changeset)}"}
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

  defp format_changeset_errors(changeset) do
    errors =
      Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
        Enum.reduce(opts, msg, fn {key, value}, acc ->
          String.replace(acc, "%{#{key}}", to_string(value))
        end)
      end)

    inspect(errors)
  end
end
