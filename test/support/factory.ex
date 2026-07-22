defmodule Manfrod.Factory do
  @moduledoc """
  Test factories for Manfrod schemas.
  """

  alias Manfrod.Desks.{Desk, DeskReservation}
  alias Manfrod.Repo
  alias Manfrod.Accounts.User
  alias Manfrod.Memory.{Conversation, Message, Node, Link}

  def fake_embedding(seed \\ "test") do
    :rand.seed(:exsss, {:erlang.phash2(seed), 0, 0})
    for _ <- 1..1024, do: :rand.uniform() - 0.5
  end

  # Users

  def insert_user!(attrs \\ %{}) do
    defaults = %{
      slack_id: "U#{System.unique_integer([:positive])}",
      slack_dm_channel_id: "D#{System.unique_integer([:positive])}",
      name: "Test User #{System.unique_integer([:positive])}"
    }

    %User{}
    |> User.changeset(Map.merge(defaults, attrs))
    |> Repo.insert!()
  end

  @doc """
  Returns a test user, creating one if needed.
  Stores the user in the process dictionary to reuse across a single test.
  """
  def test_user do
    case Process.get(:test_user) do
      nil ->
        user = insert_user!()
        Process.put(:test_user, user)
        user

      user ->
        user
    end
  end

  def test_user_id, do: test_user().id

  # Messages

  @test_session_key "D0001:1700000000.000001"

  def test_session_key, do: @test_session_key

  def message_attrs(attrs \\ %{}) do
    Map.merge(
      %{
        role: "user",
        content: "Test message #{System.unique_integer([:positive])}",
        session_key: @test_session_key,
        received_at: DateTime.utc_now() |> DateTime.truncate(:second)
      },
      attrs
    )
  end

  def insert_message!(attrs \\ %{}) do
    %Message{user_id: test_user_id()}
    |> Message.changeset(message_attrs(attrs))
    |> Repo.insert!()
  end

  # Conversations

  def conversation_attrs(attrs \\ %{}) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    Map.merge(
      %{
        started_at: DateTime.add(now, -3600, :second),
        ended_at: now,
        summary: "Test conversation #{System.unique_integer([:positive])}",
        session_key: @test_session_key
      },
      attrs
    )
  end

  def insert_conversation!(attrs \\ %{}) do
    %Conversation{user_id: test_user_id()}
    |> Conversation.changeset(conversation_attrs(attrs))
    |> Repo.insert!()
  end

  # Nodes

  def node_attrs(attrs \\ %{}) do
    content = Map.get(attrs, :content, "Test node #{System.unique_integer([:positive])}")

    Map.merge(
      %{content: content, embedding: fake_embedding(content)},
      attrs
    )
  end

  def insert_node!(attrs \\ %{}) do
    %Node{user_id: test_user_id()}
    |> Node.changeset(node_attrs(attrs))
    |> Repo.insert!()
  end

  # Links

  def insert_link!(node_a, node_b) do
    %Link{}
    |> Link.changeset(%{node_a_id: node_a.id, node_b_id: node_b.id})
    |> Repo.insert!()
  end

  # Desks

  def desk_attrs(attrs \\ %{}) do
    Map.merge(%{label: "Desk-#{System.unique_integer([:positive])}", equipment: []}, attrs)
  end

  def insert_desk!(attrs \\ %{}) do
    %Desk{}
    |> Desk.changeset(desk_attrs(attrs))
    |> Repo.insert!()
  end

  def insert_desk_reservation!(attrs \\ %{}) do
    desk = Map.get(attrs, :desk) || insert_desk!()

    defaults = %{
      desk_id: desk.id,
      user_id: test_user_id(),
      date: Date.utc_today()
    }

    %DeskReservation{}
    |> DeskReservation.changeset(Map.merge(defaults, Map.drop(attrs, [:desk])))
    |> Repo.insert!()
  end
end
