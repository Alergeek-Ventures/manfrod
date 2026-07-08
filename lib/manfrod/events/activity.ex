defmodule Manfrod.Events.Activity do
  @moduledoc """
  Represents agent activity for event subscribers.

  ## Types

  Messages:
  - `:message_received` - incoming message from any source (slack, web, scheduled)

  Actions (tool/command execution):
  - `:action_started` - action beginning (shell, eval, code write, etc.)
  - `:action_completed` - action finished with result, duration, success/fail

  Agent (conversation):
  - `:thinking` - message received, starting LLM call
  - `:narrating` - agent explaining what it's doing (text between tool calls)
  - `:responding` - final response ready
  - `:interrupted` - new message arrived, restarting with fresh context
  - `:idle` - conversation timed out

  Logs (BEAM-wide):
  - `:log` - captured from Logger (debug, info, warning, error levels)

  Memory:
  - `:memory_searched` - graph search performed
  - `:memory_node_created` - new node created
  - `:memory_node_updated` - node content updated
  - `:memory_node_deleted` - node deleted
  - `:memory_node_escalated` - node access widened after confirmation
  - `:memory_link_created` - new link created
  - `:memory_link_deleted` - link deleted
  - `:memory_node_processed` - node marked as processed
  - `:unmapped_channel_seen` - Slack channel encountered without active mapping
  - `:sensitive_content_detected` - sensitive content was detected and blocked

  Extraction:
  - `:extraction_started` - extraction began
  - `:extraction_completed` - extraction finished successfully
  - `:extraction_failed` - extraction failed

  Retrospection:
  - `:retrospection_started` - retrospection began
  - `:retrospection_completed` - retrospection finished successfully
  - `:retrospection_failed` - retrospection failed

  LLM:
  - `:llm_call_started` - LLM request initiated (model, provider, tier, purpose)
  - `:llm_call_succeeded` - LLM request succeeded (latency, tokens)
  - `:llm_call_failed` - LLM request failed (error, attempt)
  - `:llm_retry` - Retrying LLM request (delay, reason)
  - `:llm_fallback` - Falling back to next model (from/to model)

  ## Fields

  - `id` - unique event id (UUID)
  - `source` - origin of the event (:slack, :memory, :extractor, :retrospector, :logger, etc.)
  - `reply_to` - opaque reference for response routing (chat_id, pid, etc.)
  - `type` - activity type atom
  - `meta` - optional map with extra context
  - `timestamp` - when the event occurred
  """

  # Messages
  @type activity_type ::
          :message_received
          # Actions
          | :action_started
          | :action_completed
          # Agent
          | :thinking
          | :narrating
          | :responding
          | :interrupted
          | :idle
          # Logs
          | :log
          # Memory
          | :memory_searched
          | :memory_node_created
          | :memory_node_updated
          | :memory_node_deleted
          | :memory_node_escalated
          | :memory_link_created
          | :memory_link_deleted
          | :memory_node_processed
          | :unmapped_channel_seen
          | :sensitive_content_detected
          # Extraction
          | :extraction_started
          | :extraction_completed
          | :extraction_failed
          # Retrospection
          | :retrospection_started
          | :retrospection_completed
          | :retrospection_failed
          # LLM
          | :llm_call_started
          | :llm_call_succeeded
          | :llm_call_failed
          | :llm_retry
          | :llm_fallback

  @type t :: %__MODULE__{
          id: String.t(),
          user_id: String.t() | nil,
          session_key: String.t() | nil,
          source: atom(),
          reply_to: term(),
          type: activity_type(),
          meta: map(),
          timestamp: DateTime.t()
        }

  @enforce_keys [:id, :type, :timestamp]
  defstruct [:id, :user_id, :session_key, :source, :reply_to, :type, :meta, :timestamp]

  @doc """
  Create a new Activity event.

  ## Examples

      Activity.new(:message_received, %{source: :slack, meta: %{content: "Hello"}})
      Activity.new(:action_started, %{source: :agent, meta: %{action: "run_shell", action_id: "abc123", args: %{command: "ls"}}})
      Activity.new(:action_completed, %{source: :agent, meta: %{action_id: "abc123", result: "file1\\nfile2", duration_ms: 150, success: true}})
      Activity.new(:thinking, %{source: :slack, reply_to: %{channel: "D123", thread_ts: "1234.5678"}})
      Activity.new(:log, %{source: :logger, meta: %{level: :error, message: "Something failed", module: MyApp.Worker}})
  """
  def new(type, attrs \\ %{}) when is_atom(type) do
    %__MODULE__{
      id: generate_id(),
      type: type,
      user_id: Map.get(attrs, :user_id),
      session_key: Map.get(attrs, :session_key),
      source: Map.get(attrs, :source),
      reply_to: Map.get(attrs, :reply_to),
      meta: Map.get(attrs, :meta, %{}),
      timestamp: DateTime.utc_now()
    }
  end

  defp generate_id do
    Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
  end
end
