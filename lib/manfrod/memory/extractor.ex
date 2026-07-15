defmodule Manfrod.Memory.Extractor do
  @moduledoc """
  Summarizes and closes conversations on idle, for provenance.

  Flow:
  1. Fetch pending messages for the user from DB
  2. Generate conversation summary
  3. Close conversation (create record, link messages)

  Memory NODES are intentionally not created here. The passive Classifier
  (`Manfrod.Memory.Classifier`) is the single writer of memory nodes — named,
  third-person and deduplicated — including for direct agent conversations,
  whose messages are buffered like any other. Keeping node creation in one
  place avoids the generic "User did X" duplicates this module used to emit.
  """

  require Logger
  alias Manfrod.{Events, LLM, Memory}

  @summary_prompt """
  Summarize this conversation in 2-3 sentences. Focus on:
  - What was discussed
  - Key decisions or outcomes
  - Any action items or follow-ups

  Conversation:
  """

  @doc """
  Fire-and-forget extraction triggered on idle for a specific session.
  Fetches pending messages from DB, processes them, stores results.
  """
  def extract_async(user_id, session_key, write_access \\ ["internal"], slack_channel_id \\ nil) do
    Task.start(fn -> extract_and_store(user_id, session_key, write_access, slack_channel_id) end)
    :ok
  end

  @doc """
  Synchronous extraction and storage for a specific session.
  Returns {:ok, conversation, node_ids} or {:error, reason}.
  """
  def extract_and_store(
        user_id,
        session_key,
        write_access \\ ["internal"],
        slack_channel_id \\ nil
      ) do
    messages = Memory.get_pending_messages(user_id, session_key)

    if messages == [] do
      Logger.debug(
        "Extractor: no pending messages to process for user #{user_id}, session #{session_key}"
      )

      {:ok, nil, []}
    else
      do_extract_and_store(user_id, session_key, write_access, slack_channel_id, messages)
    end
  end

  defp do_extract_and_store(user_id, session_key, write_access, slack_channel_id, messages) do
    conversation_text = format_messages(messages)

    Events.broadcast(:extraction_started, %{
      user_id: user_id,
      session_key: session_key,
      source: :extractor,
      meta: %{message_count: length(messages)}
    })

    # Node creation is intentionally NOT done here: the passive Classifier is the
    # single writer of memory nodes (named, third-person, deduplicated). The
    # Extractor only summarizes and closes the conversation for provenance.
    with {:ok, summary} <- generate_summary(conversation_text),
         {:ok, conversation} <-
           Memory.close_conversation(user_id, session_key, %{
             summary: summary,
             access: write_access,
             slack_channel_id: slack_channel_id
           }) do
      Logger.info(
        "Extracted conversation #{conversation.id} for user #{user_id}: summary: #{String.slice(summary, 0, 50)}..."
      )

      Events.broadcast(:extraction_completed, %{
        user_id: user_id,
        session_key: session_key,
        source: :extractor,
        meta: %{
          conversation_id: conversation.id,
          node_count: 0,
          summary_preview: String.slice(summary, 0, 100)
        }
      })

      {:ok, conversation, []}
    else
      {:error, :no_pending_messages} ->
        Logger.debug(
          "Extractor: no pending messages (race condition) for user #{user_id}, session #{session_key}"
        )

        {:ok, nil, []}

      {:error, reason} = err ->
        Logger.error(
          "Extraction failed for user #{user_id}, session #{session_key}: #{inspect(reason)}"
        )

        Events.broadcast(:extraction_failed, %{
          user_id: user_id,
          session_key: session_key,
          source: :extractor,
          meta: %{reason: inspect(reason)}
        })

        err
    end
  end

  defp format_messages(messages) do
    messages
    |> Enum.map(fn message ->
      role = if message.role == "user", do: "User", else: "Assistant"
      "#{role}: #{message.content}"
    end)
    |> Enum.join("\n\n")
  end

  defp generate_summary(conversation_text) do
    prompt = @summary_prompt <> conversation_text
    messages = [ReqLLM.Context.user(prompt)]

    case LLM.generate_text(messages, purpose: :extractor) do
      {:ok, response} ->
        summary = ReqLLM.Response.text(response) |> String.trim()
        {:ok, summary}

      error ->
        error
    end
  end
end
