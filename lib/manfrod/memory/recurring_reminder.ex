defmodule Manfrod.Memory.RecurringReminder do
  @moduledoc """
  A recurring reminder that triggers the agent on a cron schedule.

  Each reminder links to a node that provides context/instructions for the agent
  when the reminder fires. The node's content becomes the prompt, and all notes
  linked to that node are included as additional context.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Memory.Node

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "recurring_reminders" do
    field :name, :string
    field :cron, :string
    field :timezone, :string, default: "Europe/Warsaw"
    field :enabled, :boolean, default: true

    belongs_to :user, User
    belongs_to :node, Node

    timestamps()
  end

  def changeset(reminder, attrs) do
    reminder
    |> cast(attrs, [:name, :cron, :timezone, :enabled, :node_id])
    |> validate_required([:name, :cron, :node_id])
    |> validate_cron()
    |> validate_timezone()
    |> unique_constraint(:name)
    |> foreign_key_constraint(:node_id)
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
