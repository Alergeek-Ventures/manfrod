defmodule Manfrod.Proactive do
  @moduledoc """
  Starts Agent conversations proactively (not triggered by user messages).

  Used by TriggerWorker (recurring reminders) and future proactive features.
  Creates a new Slack DM thread for the user and routes the Agent's response
  there.

  ## Flow

  1. Resolves user → gets `slack_dm_channel_id`
  2. Asks `Slack.ActivityHandler` to create a new thread (placeholder message)
  3. Computes session key from channel + thread_ts
  4. Calls `Agent.send_message/3` with the prompt and real `reply_to`

  The Agent processes the prompt and responds normally — the ActivityHandler
  updates the placeholder with the Agent's response. The user sees the
  response as a new DM thread and can reply to continue the conversation.
  """

  require Logger

  alias Manfrod.Accounts
  alias Manfrod.Agent
  alias Manfrod.Slack.ActivityHandler

  @doc """
  Send a proactive message to a user, creating a new DM thread.

  Returns `:ok` on success, `{:error, reason}` on failure.
  """
  def send(user_id, prompt) when is_binary(user_id) and is_binary(prompt) do
    user = Accounts.get_user!(user_id)
    channel = user.slack_dm_channel_id

    if is_nil(channel) do
      Logger.warning("Proactive: user #{user_id} has no DM channel, skipping proactive message")

      {:error, :no_dm_channel}
    else
      case ActivityHandler.start_thread(channel) do
        {:ok, thread_ts} ->
          session_key = "#{channel}:#{thread_ts}"

          Agent.send_message(user_id, session_key, %{
            content: prompt,
            source: :proactive,
            reply_to: %{channel: channel, thread_ts: thread_ts}
          })

          :ok

        {:error, reason} ->
          Logger.error(
            "Proactive: failed to start thread for user #{user_id}: #{inspect(reason)}"
          )

          {:error, reason}
      end
    end
  end
end
