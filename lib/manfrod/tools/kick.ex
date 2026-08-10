defmodule Manfrod.Tools.Kick do
  @moduledoc """
  Lets the agent bow out of a thread when someone in it asks it to.

  The conversational twin of the "Wyrzuć Manfroda" message shortcut: both run
  `Manfrod.Slack.Kick.run/4`, so asking nicely and clicking the menu item have
  exactly the same effect — the same persisted verdict and the same farewell.

  Only meaningful in a channel thread. DMs are the user's own conversation
  with the bot and have no permission to revoke, so the tool refuses there
  rather than pretending to do something.
  """

  alias Manfrod.Slack.Kick

  def definitions(%{msg_ctx: msg_ctx}) do
    [
      ReqLLM.Tool.new!(
        name: "leave_thread",
        description:
          "Stop participating in the current channel thread. Call this when someone in the " <>
            "thread asks you to stop replying, to leave them alone, or to butt out — e.g. " <>
            "'przestań się tu udzielać', 'zostaw nas', 'nie odzywaj się więcej w tym wątku'. " <>
            "You will post a short goodbye and then stay silent in this thread until someone " <>
            "@mentions you again. Do not call this on your own initiative, only when asked.",
        parameter_schema: [],
        callback: fn _args -> leave_thread(msg_ctx) end
      )
    ]
  end

  defp leave_thread(%{channel: channel, thread_ts: thread_ts, slack_user_id: slack_user_id})
       when is_binary(channel) and is_binary(thread_ts) do
    case Kick.run(token(), channel, thread_ts, %{
           slack_user_id: slack_user_id,
           source: "tool"
         }) do
      :ok ->
        # The farewell is already posted by Kick — telling the model to stay
        # quiet stops it appending a second goodbye of its own.
        {:ok,
         "Left the thread and posted a goodbye. Say nothing further — the goodbye has " <>
           "already been sent."}

      :already_kicked ->
        {:ok, "Already out of this thread; nothing to do. Say nothing further."}

      {:error, reason} ->
        {:ok, "Could not leave the thread: #{inspect(reason)}"}
    end
  end

  defp leave_thread(_msg_ctx) do
    {:ok,
     "Not in a channel thread, so there is nothing to leave. If this is a DM, explain that you " <>
       "can't leave a private conversation, and that they can mute or archive it instead."}
  end

  defp token, do: Application.get_env(:manfrod, :slack_bot_token)
end
