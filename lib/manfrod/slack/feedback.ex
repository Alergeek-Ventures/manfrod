defmodule Manfrod.Slack.Feedback do
  @moduledoc """
  Thumbs up/down on the agent's answers.

  Slack renders the pair as a `feedback_buttons` element in a `context_actions`
  block and handles the pressed state itself, so there is nothing to
  acknowledge in the thread — a click just needs recording.

  Ratings are stored as `:feedback_received` activity events rather than in a
  table of their own: they carry the same `user_id`/`session_key` attribution
  as every other event, which is what makes them joinable against the response
  they are rating in `Manfrod.Analytics`.
  """

  require Logger

  alias Manfrod.Accounts
  alias Manfrod.Events
  alias Manfrod.Slack.API

  @action_id "manfrod_feedback"
  @remove_action_id "manfrod_feedback_remove"

  @doc "The action_id of the thumbs up/down pair, to match on in `block_actions`."
  @spec action_id() :: String.t()
  def action_id, do: @action_id

  @doc "The action_id of the delete button, to match on in `block_actions`."
  @spec remove_action_id() :: String.t()
  def remove_action_id, do: @remove_action_id

  @doc """
  A `blocks` stream chunk carrying the feedback buttons, to append as the last
  thing before a stream is finalized.
  """
  @spec buttons_chunk(String.t() | nil) :: map()
  def buttons_chunk(session_key) do
    %{type: "blocks", blocks: [block(session_key)]}
  end

  @doc """
  The `context_actions` block itself, for callers assembling a message body
  rather than a stream.
  """
  @spec block(String.t() | nil) :: map()
  def block(session_key) do
    %{
      type: "context_actions",
      elements: [
        %{
          type: "feedback_buttons",
          action_id: @action_id,
          positive_button: %{
            text: %{type: "plain_text", text: "Dobra odpowiedź"},
            value: encode("good", session_key),
            accessibility_label: "Oceń odpowiedź pozytywnie"
          },
          negative_button: %{
            text: %{type: "plain_text", text: "Słaba odpowiedź"},
            value: encode("bad", session_key),
            accessibility_label: "Oceń odpowiedź negatywnie"
          }
        },
        %{
          type: "icon_button",
          action_id: @remove_action_id,
          icon: "trash",
          text: %{type: "plain_text", text: "Usuń"},
          accessibility_label: "Usuń tę odpowiedź"
        }
      ]
    }
  end

  @doc """
  Delete the message the button was attached to.

  Slack only lets an app delete its own messages, and this button only ever
  appears on the app's own answers, so no ownership check is needed beyond
  what Slack already enforces.
  """
  @spec remove(map(), String.t()) :: :ok
  def remove(payload, bot_token) do
    channel_id = get_in(payload, ["channel", "id"])
    message_ts = get_in(payload, ["message", "ts"])

    case API.delete_message(bot_token, channel_id, message_ts) do
      {:ok, _body} ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "Slack feedback: failed to remove #{channel_id}/#{message_ts}: #{inspect(reason)}"
        )
    end

    :ok
  end

  @doc """
  Record a click. Takes the raw `block_actions` payload, the action that was
  matched on `action_id/0`, and the bot token used to resolve the channel name
  and permalink.

  Written twice over, deliberately: an activity event so the rating shows up
  live alongside everything else the agent did, and a `Manfrod.Feedback` row
  that outlives the 7-day audit retention and backs the analytics page.
  """
  @spec record(map(), map(), String.t() | nil) :: :ok
  def record(payload, action, bot_token \\ nil) do
    {rating, session_key} = decode(action["value"])
    slack_user_id = get_in(payload, ["user", "id"])
    channel_id = get_in(payload, ["channel", "id"])
    message_ts = get_in(payload, ["message", "ts"])

    user = slack_user_id && Accounts.get_user_by_slack_id(slack_user_id)

    Events.broadcast(:feedback_received, %{
      user_id: user && user.id,
      session_key: session_key,
      source: :slack,
      meta: %{
        rating: rating,
        slack_user_id: slack_user_id,
        slack_channel_id: channel_id,
        message_ts: message_ts
      }
    })

    persist(bot_token, %{
      user_id: user && user.id,
      slack_user_id: slack_user_id,
      slack_user_name: rater_name(user, payload),
      slack_channel_id: channel_id,
      message_ts: message_ts,
      session_key: session_key,
      rating: rating
    })

    Logger.info(
      "Slack feedback: #{rating} from #{slack_user_id} on #{channel_id}/#{message_ts} " <>
        "(session #{session_key || "unknown"})"
    )

    :ok
  end

  # The channel name and permalink are resolved now rather than when the
  # analytics page is opened: the message may be deleted by then, and an admin
  # looking at a complaint should not wait on two Slack round trips per row.
  defp persist(bot_token, attrs) do
    attrs =
      attrs
      |> Map.put(:slack_channel_name, channel_name(bot_token, attrs.slack_channel_id))
      |> Map.put(:permalink, permalink(bot_token, attrs.slack_channel_id, attrs.message_ts))

    case Manfrod.Feedback.record(attrs) do
      {:ok, _feedback} ->
        :ok

      {:error, changeset} ->
        Logger.warning("Slack feedback: failed to store rating: #{inspect(changeset.errors)}")
    end
  end

  defp rater_name(%{name: name}, _payload) when is_binary(name) and name != "", do: name
  defp rater_name(_user, payload), do: get_in(payload, ["user", "username"])

  defp channel_name(nil, _channel_id), do: nil
  defp channel_name(_bot_token, nil), do: nil
  defp channel_name(_bot_token, "D" <> _), do: "DM"

  defp channel_name(bot_token, channel_id) do
    case API.get_channel_info(bot_token, channel_id) do
      {:ok, %{"name" => name}} -> name
      _ -> nil
    end
  end

  defp permalink(nil, _channel_id, _message_ts), do: nil
  defp permalink(_bot_token, nil, _message_ts), do: nil
  defp permalink(_bot_token, _channel_id, nil), do: nil

  defp permalink(bot_token, channel_id, message_ts) do
    case API.get_permalink(bot_token, channel_id, message_ts) do
      {:ok, permalink} -> permalink
      {:error, _reason} -> nil
    end
  end

  # "good"/"bad" prefixed onto the session so a rating can be traced back to
  # the conversation that produced it, without a lookup table keyed on message
  # timestamps that would have to be kept alive across restarts.
  defp encode(rating, nil), do: rating
  defp encode(rating, session_key), do: rating <> ":" <> session_key

  defp decode(value) when is_binary(value) do
    case String.split(value, ":", parts: 2) do
      [rating, session_key] -> {rating, session_key}
      [rating] -> {rating, nil}
    end
  end

  defp decode(_value), do: {"unknown", nil}
end
