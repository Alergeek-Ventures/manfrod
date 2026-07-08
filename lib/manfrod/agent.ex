defmodule Manfrod.Agent do
  @moduledoc """
  Public API for the Agent — routes messages to per-session Agent processes.

  Each session (user + thread) gets an isolated Agent process with its own
  conversation history, inbox, and flush timer. Processes are started on demand
  and terminate after idle timeout.

  Sessions are identified by `session_key` — a string derived from the Slack
  channel and thread timestamp (`"channel:thread_ts"`).

  ## Event-driven architecture

  The Agent broadcasts Activity events on per-user PubSub topics:
  - `:thinking` - message received, starting LLM call
  - `:narrating` - agent explaining what it's doing (text between tool calls)
  - `:action_started` - beginning action execution (tool name, args)
  - `:action_completed` - action finished (result, duration, success/fail)
  - `:responding` - final response ready
  - `:idle` - conversation timed out

  Subscribers (Slack.ActivityHandler, Memory.FlushHandler, ActivityLive) handle
  these events appropriately for their context.
  """

  alias Manfrod.Agent.Server
  alias Manfrod.Memory.Access

  @doc """
  Send a message to the agent for a specific session.

  Starts the per-session Agent process if it's not already running.
  The agent will process the message and broadcast Activity events.

  ## Required fields in message

  - `content` - the message text
  - `source` - origin atom (:slack, :proactive, :web, etc.)
  - `reply_to` - opaque reference for response routing (channel, thread_ts)

  `slack_channel_id` is used to resolve write_access and readable_levels.
  Defaults to DM-level access if not provided. Unmapped Slack channels use internal access.
  """
  def send_message(user_id, session_key, message, slack_channel_id \\ nil)
      when is_binary(user_id) and is_binary(session_key) and is_map(message) do
    {:ok, write_access, readable_levels} = resolve_access(user_id, slack_channel_id)
    ensure_started(user_id, session_key, write_access, readable_levels)
    GenServer.cast(Server.via(user_id, session_key), {:message, message})
  end

  defp resolve_access(_user_id, nil) do
    {:ok, ["internal"], ["internal", "external/all"]}
  end

  defp resolve_access(user_id, channel_id) do
    ensure_project_membership(user_id, channel_id)
    {:ok, write} = Access.resolve_for_write(channel_id)
    {:ok, readable} = Access.resolve_for_read(user_id, channel_id)
    {:ok, write, readable}
  end

  # Talking on a project channel auto-enrolls the user as a project member,
  # so their DM/company-channel reads include the project's external levels.
  defp ensure_project_membership(user_id, channel_id) do
    case Access.get_active_mapping(channel_id) do
      %{project_id: project_id} when not is_nil(project_id) ->
        Access.ensure_membership!(user_id, project_id)

      _ ->
        :ok
    end
  end

  @doc """
  Manually trigger idle state for a session (close conversation and extract memories).
  """
  def trigger_idle(user_id, session_key, event_ctx)
      when is_binary(user_id) and is_binary(session_key) do
    case Registry.lookup(Manfrod.Agent.Registry, {user_id, session_key}) do
      [{_pid, _}] ->
        GenServer.cast(Server.via(user_id, session_key), {:trigger_idle, event_ctx})

      [] ->
        :ok
    end
  end

  defp ensure_started(user_id, session_key, write_access, readable_levels) do
    case Registry.lookup(Manfrod.Agent.Registry, {user_id, session_key}) do
      [{_pid, _}] ->
        :ok

      [] ->
        case DynamicSupervisor.start_child(
               Manfrod.Agent.DynamicSupervisor,
               {Server, {user_id, session_key, write_access, readable_levels}}
             ) do
          {:ok, _pid} -> :ok
          {:error, {:already_started, _pid}} -> :ok
        end
    end
  end
end
