defmodule Manfrod.Feedback do
  @moduledoc """
  Ratings people gave the agent's answers.

  Kept in a table of its own rather than read back out of `audit_events`,
  which are purged after 7 days: a satisfaction trend that resets weekly is
  not a trend, and the whole point of the negative ratings is to still be able
  to go and look at them later.

  Low volume by nature — a few clicks a day at most — so this reads straight
  from the table instead of going through the daily rollups.
  """

  import Ecto.Query

  alias Manfrod.Feedback.MessageFeedback
  alias Manfrod.Repo

  @doc """
  Record a rating, replacing this person's previous rating of the same message.

  Slack lets someone change their mind, which arrives as another click on the
  same message — that is a correction, not a second opinion.
  """
  @spec record(map()) :: {:ok, MessageFeedback.t()} | {:error, Ecto.Changeset.t()}
  def record(attrs) do
    %MessageFeedback{}
    |> MessageFeedback.changeset(attrs)
    |> Repo.insert(
      on_conflict: {:replace, [:rating, :permalink, :slack_user_name, :updated_at]},
      conflict_target: {:unsafe_fragment, "(slack_channel_id, message_ts, slack_user_id)"}
    )
  end

  @doc """
  Satisfaction over the last `days` days.

  `score` is the share of ratings that were positive, as a percentage, or nil
  when nobody rated anything — which is not the same as nobody being happy,
  and must not render as 0%.
  """
  @spec stats(pos_integer()) :: %{
          good: non_neg_integer(),
          bad: non_neg_integer(),
          total: non_neg_integer(),
          score: float() | nil
        }
  def stats(days) do
    counts =
      MessageFeedback
      |> where([f], f.inserted_at >= ^since(days))
      |> group_by([f], f.rating)
      |> select([f], {f.rating, count(f.id)})
      |> Repo.all()
      |> Map.new()

    good = Map.get(counts, "good", 0)
    bad = Map.get(counts, "bad", 0)
    total = good + bad

    %{
      good: good,
      bad: bad,
      total: total,
      score: if(total > 0, do: Float.round(good * 100 / total, 1))
    }
  end

  @doc """
  The negative ratings from the last `days` days, newest first — who, when,
  where, and a link to the message itself.
  """
  @spec list_negative(pos_integer(), keyword()) :: [MessageFeedback.t()]
  def list_negative(days, opts \\ []) do
    MessageFeedback
    |> where([f], f.rating == "bad" and f.inserted_at >= ^since(days))
    |> order_by([f], desc: f.inserted_at)
    |> limit(^Keyword.get(opts, :limit, 50))
    |> preload(:user)
    |> Repo.all()
  end

  # `timestamps()` stores naive UTC, so the cutoff has to be naive too — a
  # DateTime here fails to cast rather than silently comparing wrong.
  defp since(days) do
    NaiveDateTime.utc_now()
    |> NaiveDateTime.add(-days, :day)
    |> NaiveDateTime.truncate(:second)
  end
end
