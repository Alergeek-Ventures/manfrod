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
  Record a click. Takes the raw `block_actions` payload and the action that was
  matched on `action_id/0`.
  """
  @spec record(map(), map()) :: :ok
  def record(payload, action) do
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

    Logger.info(
      "Slack feedback: #{rating} from #{slack_user_id} on #{channel_id}/#{message_ts} " <>
        "(session #{session_key || "unknown"})"
    )

    :ok
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
