defmodule Manfrod.Events do
  @moduledoc """
  Event bus for agent activity.

  Broadcasts Activity events via Phoenix.PubSub on two topic layers:

  - **Per-user topics** (`"agent:activity:<user_id>"`) — for user-scoped
    subscribers like per-user FlushHandler, TypingRefresher, and ActivityHandler.
  - **Global topic** (`"agent:activity"`) — for admin/observability subscribers
    like Persister and admin LiveViews that need to see all events.

  Every broadcast goes to both the user's topic and the global topic.
  """

  alias Manfrod.Events.Activity

  @pubsub Manfrod.PubSub
  @global_topic "agent:activity"

  @doc """
  Subscribe to a specific user's activity events.
  """
  def subscribe(user_id) when is_binary(user_id) do
    Phoenix.PubSub.subscribe(@pubsub, topic(user_id))
  end

  @doc """
  Subscribe to all activity events (global/admin).
  """
  def subscribe_global do
    Phoenix.PubSub.subscribe(@pubsub, @global_topic)
  end

  @doc """
  Unsubscribe from a specific user's activity events.
  """
  def unsubscribe(user_id) when is_binary(user_id) do
    Phoenix.PubSub.unsubscribe(@pubsub, topic(user_id))
  end

  @doc """
  Broadcast an activity event.

  Sends to both the per-user topic and the global topic.
  """
  def broadcast(%Activity{} = activity) do
    message = {:activity, activity}

    if activity.user_id do
      Phoenix.PubSub.broadcast(@pubsub, topic(activity.user_id), message)
    end

    Phoenix.PubSub.broadcast(@pubsub, @global_topic, message)
  end

  @doc """
  Build and broadcast an activity event.
  """
  def broadcast(type, attrs) when is_atom(type) and is_map(attrs) do
    activity = Activity.new(type, attrs)
    broadcast(activity)
  end

  @doc """
  Returns the PubSub topic for a given user.
  """
  def topic(user_id) when is_binary(user_id) do
    "#{@global_topic}:#{user_id}"
  end
end
