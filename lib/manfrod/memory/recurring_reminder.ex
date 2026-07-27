defmodule Manfrod.Memory.RecurringReminder do
  @moduledoc """
  A recurring reminder that triggers the agent on a cron schedule.

  `instructions` is the prompt: when the cron fires, that text becomes a full
  autonomous agent turn (see `Manfrod.Workers.TriggerWorker`).

  Instructions are stored inline rather than as a `nodes` row on purpose.
  They are configuration, not knowledge — a node would be subject to
  retrospection, which deduplicates and rewrites node content by design and
  would silently change what the cron does (see the migration
  `MoveReminderInstructionsInline` for the failure modes this avoids).
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "recurring_reminders" do
    field :name, :string
    field :cron, :string
    field :instructions, :string
    field :timezone, :string, default: "Europe/Warsaw"
    field :enabled, :boolean, default: true

    belongs_to :user, User

    timestamps()
  end

  def changeset(reminder, attrs) do
    reminder
    |> cast(attrs, [:name, :cron, :instructions, :timezone, :enabled])
    |> validate_required([:name, :cron, :instructions])
    |> validate_cron()
    |> validate_timezone()
    |> unique_constraint(:name)
  end

  defp validate_cron(changeset) do
    validate_change(changeset, :cron, fn :cron, cron ->
      case Crontab.CronExpression.Parser.parse(cron) do
        {:ok, _} -> []
        {:error, reason} -> [cron: "invalid cron expression: #{inspect(reason)}"]
      end
    end)
  end

  defp validate_timezone(changeset) do
    validate_change(changeset, :timezone, fn :timezone, timezone ->
      if Tzdata.zone_exists?(timezone) do
        []
      else
        [timezone: "unknown timezone"]
      end
    end)
  end
end
