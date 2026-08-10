defmodule Manfrod.Slack.ThreadKick do
  @moduledoc """
  A thread the bot was told to leave.

  The durable half of `Manfrod.Slack.ThreadPermission`: that module derives
  permission from Slack (was the bot @mentioned in this thread?), which can
  only ever answer "yes". A kick is the standing "no" that outranks it, so it
  has to live somewhere Slack can't contradict.

  Un-kicking is deliberately not an update — the row is deleted when someone
  @mentions the bot again, so the thread goes back to being governed by the
  ordinary mention rule with no special case.
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @type t :: %__MODULE__{}

  @sources ~w(shortcut tool)

  @fields [:slack_channel_id, :thread_ts, :user_id, :slack_user_id, :source]

  schema "thread_kicks" do
    field :slack_channel_id, :string
    field :thread_ts, :string
    field :slack_user_id, :string
    field :source, :string

    belongs_to :user, User

    timestamps()
  end

  def changeset(kick \\ %__MODULE__{}, attrs) do
    kick
    |> cast(attrs, @fields)
    |> validate_required([:slack_channel_id, :thread_ts, :source])
    |> validate_inclusion(:source, @sources)
    |> unique_constraint([:slack_channel_id, :thread_ts])
  end
end
