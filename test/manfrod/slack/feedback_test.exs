defmodule Manfrod.Slack.FeedbackTest do
  use Manfrod.DataCase

  alias Manfrod.Events
  alias Manfrod.Events.Activity
  alias Manfrod.Slack.Feedback

  @moduletag :db

  defp payload(slack_user_id) do
    %{
      "user" => %{"id" => slack_user_id},
      "channel" => %{"id" => "D123"},
      "message" => %{"ts" => "1712345678.000100"}
    }
  end

  defp action(value) do
    %{"action_id" => Feedback.action_id(), "value" => value}
  end

  defp buttons(session_key) do
    %{elements: elements} = Feedback.block(session_key)
    Enum.find(elements, &(&1.action_id == Feedback.action_id()))
  end

  describe "block/1" do
    test "carries the session on both buttons so a rating can be traced back" do
      element = buttons("D123:1712345678.000100")

      assert element.positive_button.value == "good:D123:1712345678.000100"
      assert element.negative_button.value == "bad:D123:1712345678.000100"
    end

    test "still builds a usable element without a session" do
      element = buttons(nil)

      assert element.positive_button.value == "good"
      assert element.negative_button.value == "bad"
    end

    test "offers a delete button alongside the rating" do
      %{elements: elements} = Feedback.block("D123:1.0")

      remove = Enum.find(elements, &(&1.action_id == Feedback.remove_action_id()))

      assert remove.type == "icon_button"
      assert remove.icon == "trash"
    end
  end

  describe "record/2" do
    setup do
      Events.subscribe_global()
      :ok
    end

    test "attributes the rating to the Manfrod user behind the Slack id" do
      user = insert_user!(%{slack_id: "U_FEEDBACK"})
      session_key = "D123:1712345678.000100"

      Feedback.record(payload("U_FEEDBACK"), action("good:" <> session_key))

      assert_receive {:activity, %Activity{type: :feedback_received} = activity}
      assert activity.user_id == user.id
      assert activity.session_key == session_key
      assert activity.meta.rating == "good"
      assert activity.meta.message_ts == "1712345678.000100"
    end

    # Someone can rate an answer in a channel without ever having DMed the bot.
    # The rating is still worth having, just unattributed.
    test "records a rating from an unknown user without a Manfrod id" do
      Feedback.record(payload("U_STRANGER"), action("bad:D123:1.0"))

      assert_receive {:activity, %Activity{type: :feedback_received} = activity}
      assert activity.user_id == nil
      assert activity.meta.rating == "bad"
      assert activity.meta.slack_user_id == "U_STRANGER"
    end
  end
end
