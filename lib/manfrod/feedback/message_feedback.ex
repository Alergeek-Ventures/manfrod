defmodule Manfrod.Feedback.MessageFeedback do
  @moduledoc """
  One person's rating of one answer.

  The durable record behind the Slack feedback buttons — see
  `Manfrod.Feedback` for why this is a table of its own rather than an audit
  event.
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @type t :: %__MODULE__{}

  @ratings ~w(good bad)

  @fields [
    :user_id,
    :slack_user_id,
    :slack_user_name,
    :slack_channel_id,
    :slack_channel_name,
    :message_ts,
    :session_key,
    :rating,
    :permalink
  ]

  schema "message_feedback" do
    field :slack_user_id, :string
    field :slack_user_name, :string
    field :slack_channel_id, :string
    field :slack_channel_name, :string
    field :message_ts, :string
    field :session_key, :string
    field :rating, :string
    field :permalink, :string

    belongs_to :user, User

    timestamps()
  end

  @doc "Valid rating values."
  @spec ratings() :: [String.t()]
  def ratings, do: @ratings

  def changeset(feedback, attrs) do
    feedback
    |> cast(attrs, @fields)
    |> validate_required([:slack_channel_id, :message_ts, :rating])
    |> validate_inclusion(:rating, @ratings)
  end
end
