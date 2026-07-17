defmodule Manfrod.MemoryTest do
  use Manfrod.DataCase

  alias Manfrod.Memory

  @moduletag :db

  describe "messages" do
    test "create_message/2 creates a pending message" do
      user_id = test_user_id()
      attrs = message_attrs()
      assert {:ok, msg} = Memory.create_message(user_id, attrs)
      assert msg.role == attrs.role
      assert msg.content == attrs.content
      assert is_nil(msg.conversation_id)
      assert msg.user_id == user_id
    end

    test "get_pending_messages/2 returns messages without conversation" do
      user_id = test_user_id()
      session_key = test_session_key()
      m1 = insert_message!(%{received_at: ~U[2024-01-01 10:00:00Z]})
      m2 = insert_message!(%{received_at: ~U[2024-01-01 10:01:00Z]})

      # Create a conversation and assign one message to it
      conv = insert_conversation!()
      Repo.update!(Ecto.Changeset.change(m2, conversation_id: conv.id))

      pending = Memory.get_pending_messages(user_id, session_key)
      assert length(pending) == 1
      assert hd(pending).id == m1.id
    end

    test "get_pending_messages/2 returns messages ordered by received_at" do
      user_id = test_user_id()
      session_key = test_session_key()
      m2 = insert_message!(%{received_at: ~U[2024-01-01 10:01:00Z]})
      m1 = insert_message!(%{received_at: ~U[2024-01-01 10:00:00Z]})
      m3 = insert_message!(%{received_at: ~U[2024-01-01 10:02:00Z]})

      pending = Memory.get_pending_messages(user_id, session_key)
      assert Enum.map(pending, & &1.id) == [m1.id, m2.id, m3.id]
    end

    test "get_pending_messages/2 scopes by session_key" do
      user_id = test_user_id()
      session_a = "D0001:1700000001.000001"
      session_b = "D0001:1700000002.000001"

      _m1 = insert_message!(%{session_key: session_a, received_at: ~U[2024-01-01 10:00:00Z]})
      _m2 = insert_message!(%{session_key: session_b, received_at: ~U[2024-01-01 10:01:00Z]})

      pending_a = Memory.get_pending_messages(user_id, session_a)
      pending_b = Memory.get_pending_messages(user_id, session_b)
      assert length(pending_a) == 1
      assert length(pending_b) == 1
    end
  end

  describe "conversations" do
    test "close_conversation/3 creates conversation and links pending messages" do
      user_id = test_user_id()
      session_key = test_session_key()
      m1 = insert_message!(%{received_at: ~U[2024-01-01 10:00:00Z]})
      m2 = insert_message!(%{received_at: ~U[2024-01-01 10:05:00Z]})

      assert {:ok, conv} =
               Memory.close_conversation(user_id, session_key, %{summary: "Test summary"})

      assert conv.summary == "Test summary"
      assert conv.session_key == session_key
      assert conv.started_at == ~U[2024-01-01 10:00:00Z]
      assert conv.ended_at == ~U[2024-01-01 10:05:00Z]

      # Messages should now be linked
      m1_reloaded = Repo.get!(Manfrod.Memory.Message, m1.id)
      m2_reloaded = Repo.get!(Manfrod.Memory.Message, m2.id)
      assert m1_reloaded.conversation_id == conv.id
      assert m2_reloaded.conversation_id == conv.id

      # No more pending messages
      assert Memory.get_pending_messages(user_id, session_key) == []
    end

    test "close_conversation/3 fails when no pending messages" do
      user_id = test_user_id()
      session_key = test_session_key()

      assert {:error, :no_pending_messages} =
               Memory.close_conversation(user_id, session_key, %{summary: "Test"})
    end

    test "close_conversation/3 scopes to session" do
      user_id = test_user_id()
      session_a = "D0001:1700000001.000001"
      session_b = "D0001:1700000002.000001"

      _m1 = insert_message!(%{session_key: session_a, received_at: ~U[2024-01-01 10:00:00Z]})
      _m2 = insert_message!(%{session_key: session_b, received_at: ~U[2024-01-01 10:01:00Z]})

      # Close only session_a
      assert {:ok, conv} =
               Memory.close_conversation(user_id, session_a, %{summary: "Session A"})

      assert conv.session_key == session_a

      # session_b still has pending messages
      assert length(Memory.get_pending_messages(user_id, session_b)) == 1
    end

    test "get_conversation_with_messages/2 preloads messages" do
      user_id = test_user_id()
      session_key = test_session_key()
      m1 = insert_message!(%{received_at: ~U[2024-01-01 10:00:00Z]})
      _m2 = insert_message!(%{received_at: ~U[2024-01-01 10:05:00Z]})
      {:ok, conv} = Memory.close_conversation(user_id, session_key, %{summary: "Test"})

      loaded = Memory.get_conversation_with_messages(user_id, conv.id)
      assert length(loaded.messages) == 2
      assert m1.id in Enum.map(loaded.messages, & &1.id)
    end
  end

  describe "nodes" do
    test "create_node/3 creates a node" do
      user_id = test_user_id()
      attrs = node_attrs(%{content: "Test fact"})
      assert {:ok, node} = Memory.create_node(user_id, ["internal"], attrs)
      assert node.content == "Test fact"
      assert is_nil(node.processed_at)
      assert node.user_id == user_id
      assert node.access == ["internal"]
    end

    test "list_nodes/2 returns nodes ordered by inserted_at desc" do
      user_id = test_user_id()
      # Insert directly with explicit timestamps to ensure ordering
      now = NaiveDateTime.utc_now() |> NaiveDateTime.truncate(:second)
      earlier = NaiveDateTime.add(now, -60, :second)

      n1 =
        Repo.insert!(%Manfrod.Memory.Node{
          user_id: user_id,
          content: "first",
          inserted_at: earlier,
          updated_at: earlier
        })

      n2 =
        Repo.insert!(%Manfrod.Memory.Node{
          user_id: user_id,
          content: "second",
          inserted_at: now,
          updated_at: now
        })

      nodes = Memory.list_nodes(user_id)
      assert Enum.map(nodes, & &1.id) == [n2.id, n1.id]
    end

    test "list_nodes/2 respects limit" do
      user_id = test_user_id()
      for _ <- 1..5, do: insert_node!()
      assert length(Memory.list_nodes(user_id, limit: 3)) == 3
    end

    test "get_slipbox_nodes/2 returns unprocessed nodes" do
      user_id = test_user_id()
      n1 = insert_node!()
      n2 = insert_node!(%{processed_at: DateTime.utc_now() |> DateTime.truncate(:second)})

      slipbox = Memory.get_slipbox_nodes(user_id)
      ids = Enum.map(slipbox, & &1.id)
      assert n1.id in ids
      refute n2.id in ids
    end

    test "get_node/2 returns node by id" do
      user_id = test_user_id()
      node = insert_node!(%{content: "Find me"})
      found = Memory.get_node(user_id, node.id)
      assert found.content == "Find me"
    end

    test "mark_processed/2 sets processed_at" do
      user_id = test_user_id()
      node = insert_node!()
      assert is_nil(node.processed_at)

      :ok = Memory.mark_processed(user_id, node.id)

      reloaded = Memory.get_node(user_id, node.id)
      refute is_nil(reloaded.processed_at)
    end
  end

  describe "similar_nodes/3" do
    test "returns nearest nodes by embedding, excluding the node itself" do
      seed = "shared-seed-#{System.unique_integer([:positive])}"
      base = insert_node!(%{embedding: fake_embedding(seed)})
      twin = insert_node!(%{embedding: fake_embedding(seed)})

      results = Memory.similar_nodes(base, ["internal"], limit: 2)

      assert [{first, distance} | _] = results
      assert first.id == twin.id
      assert_in_delta distance, 0.0, 1.0e-6
      refute Enum.any?(results, fn {n, _} -> n.id == base.id end)
    end

    test "respects max_distance" do
      base = insert_node!(%{embedding: fake_embedding("alpha")})
      far = insert_node!(%{embedding: fake_embedding("beta")})

      results = Memory.similar_nodes(base, ["internal"], max_distance: 0.1, limit: 50)

      refute Enum.any?(results, fn {n, _} -> n.id == far.id end)
    end

    test "returns [] for a node without an embedding" do
      node = %Manfrod.Memory.Node{id: Ecto.UUID.generate(), embedding: nil}

      assert Memory.similar_nodes(node, ["internal"]) == []
    end
  end

  describe "links" do
    test "create_link/3 creates a link between nodes" do
      user_id = test_user_id()
      n1 = insert_node!()
      n2 = insert_node!()

      assert {:ok, link} = Memory.create_link(user_id, n1.id, n2.id)
      assert link.node_a_id == min(n1.id, n2.id)
      assert link.node_b_id == max(n1.id, n2.id)
    end

    test "create_link/3 normalizes node order" do
      user_id = test_user_id()
      n1 = insert_node!()
      n2 = insert_node!()

      # Create with reversed order
      {:ok, link} = Memory.create_link(user_id, n2.id, n1.id)

      # Should still be normalized
      assert link.node_a_id == min(n1.id, n2.id)
      assert link.node_b_id == max(n1.id, n2.id)
    end

    test "create_link/3 is idempotent" do
      user_id = test_user_id()
      n1 = insert_node!()
      n2 = insert_node!()

      {:ok, _} = Memory.create_link(user_id, n1.id, n2.id)
      {:ok, _} = Memory.create_link(user_id, n1.id, n2.id)
      {:ok, _} = Memory.create_link(user_id, n2.id, n1.id)

      # Should only have one link between this pair. Scoped to the pair, not
      # a global count — the test sandbox runs on top of the local dev
      # database, so unrelated links may already exist.
      count =
        Repo.aggregate(
          from(l in Manfrod.Memory.Link,
            where: l.node_a_id in ^[n1.id, n2.id] and l.node_b_id in ^[n1.id, n2.id]
          ),
          :count,
          :id
        )

      assert count == 1
    end
  end

  describe "soul" do
    test "has_soul?/1 returns false when no nodes" do
      user_id = test_user_id()
      refute Memory.has_soul?(user_id)
    end

    test "has_soul?/1 returns true when nodes exist" do
      user_id = test_user_id()
      insert_node!()
      assert Memory.has_soul?(user_id)
    end

    test "get_soul/1 returns first node by insertion" do
      user_id = test_user_id()
      n1 = insert_node!(%{content: "First soul"})
      Process.sleep(10)
      _n2 = insert_node!(%{content: "Second"})

      soul = Memory.get_soul(user_id)
      assert soul.id == n1.id
      assert soul.content == "First soul"
    end
  end

  describe "build_context/1" do
    test "returns empty string for empty list" do
      assert Memory.build_context([]) == ""
    end

    test "formats nodes with UUIDs and tools hint" do
      n1 = insert_node!(%{content: "Fact one"})
      n2 = insert_node!(%{content: "Fact two"})

      context = Memory.build_context([n1, n2])
      assert context =~ "Relevant memories"
      assert context =~ "recall_memory"
      assert context =~ "get_memory"
      assert context =~ "[#{n1.id}] Fact one"
      assert context =~ "[#{n2.id}] Fact two"
    end
  end
end
