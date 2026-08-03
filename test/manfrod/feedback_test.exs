defmodule Manfrod.FeedbackTest do
  use Manfrod.DataCase

  alias Manfrod.Feedback

  @moduletag :db

  defp rating(attrs) do
    defaults = %{
      slack_channel_id: "C123",
      message_ts: "1712345678.#{System.unique_integer([:positive])}",
      slack_user_id: "U1",
      rating: "good"
    }

    {:ok, feedback} = Feedback.record(Map.merge(defaults, attrs))
    feedback
  end

  defp age!(feedback, days) do
    at = NaiveDateTime.add(NaiveDateTime.utc_now(), -days, :day) |> NaiveDateTime.truncate(:second)

    feedback
    |> Ecto.Changeset.change(inserted_at: at)
    |> Repo.update!()
  end

  describe "record/1" do
    test "a person changing their mind corrects the rating instead of adding one" do
      ts = "1712345678.000100"

      rating(%{message_ts: ts, rating: "good"})
      rating(%{message_ts: ts, rating: "bad"})

      assert %{good: 0, bad: 1, total: 1} = Feedback.stats(30)
    end

    test "two people rating the same message are two ratings" do
      ts = "1712345678.000100"

      rating(%{message_ts: ts, slack_user_id: "U1", rating: "good"})
      rating(%{message_ts: ts, slack_user_id: "U2", rating: "bad"})

      assert %{good: 1, bad: 1, total: 2} = Feedback.stats(30)
    end

    test "rejects a rating that is neither good nor bad" do
      assert {:error, changeset} =
               Feedback.record(%{
                 slack_channel_id: "C123",
                 message_ts: "1.0",
                 rating: "meh"
               })

      assert {"is invalid", _} = changeset.errors[:rating]
    end
  end

  describe "stats/1" do
    # 0% satisfaction and "nobody has said anything" are very different
    # things, and rendering the second as the first would be alarming.
    test "reports no score at all rather than zero when nothing was rated" do
      assert %{total: 0, score: nil} = Feedback.stats(30)
    end

    test "scores the share of positive ratings" do
      rating(%{slack_user_id: "U1", rating: "good"})
      rating(%{slack_user_id: "U2", rating: "good"})
      rating(%{slack_user_id: "U3", rating: "good"})
      rating(%{slack_user_id: "U4", rating: "bad"})

      assert %{good: 3, bad: 1, total: 4, score: 75.0} = Feedback.stats(30)
    end

    test "counts only the window asked for" do
      rating(%{slack_user_id: "U1", rating: "good"})
      rating(%{slack_user_id: "U2", rating: "bad"}) |> age!(10)

      assert %{total: 1, score: 100.0} = Feedback.stats(7)
      assert %{total: 2, score: 50.0} = Feedback.stats(30)
    end
  end

  describe "list_negative/2" do
    test "returns only the bad ones, newest first" do
      rating(%{slack_user_id: "U1", rating: "good"})
      older = rating(%{slack_user_id: "U2", rating: "bad"}) |> age!(3)
      newer = rating(%{slack_user_id: "U3", rating: "bad"}) |> age!(1)

      assert [first, second] = Feedback.list_negative(30)
      assert first.id == newer.id
      assert second.id == older.id
    end

    test "carries what an admin needs to go and look at the message" do
      rating(%{
        rating: "bad",
        slack_channel_name: "general",
        slack_user_name: "Kamil Marczak",
        permalink: "https://example.slack.com/archives/C123/p1712345678000100"
      })

      assert [feedback] = Feedback.list_negative(30)
      assert feedback.slack_user_name == "Kamil Marczak"
      assert feedback.slack_channel_name == "general"
      assert feedback.permalink =~ "slack.com/archives"
    end

    test "leaves out ratings older than the window" do
      rating(%{rating: "bad"}) |> age!(10)

      assert Feedback.list_negative(7) == []
    end
  end
end
