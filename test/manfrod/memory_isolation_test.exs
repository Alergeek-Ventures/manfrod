defmodule Manfrod.MemoryIsolationTest do
  use Manfrod.DataCase, async: false

  alias Manfrod.Memory
  alias Manfrod.Memory.Access

  @embedding List.duplicate(0.1, 1024)

  setup do
    user = insert_user!()
    uid = user.id

    {:ok, n_internal} =
      Memory.create_node(uid, ["internal"], %{
        content: "internal only secret",
        embedding: @embedding
      })

    {:ok, n_ext_10bps} =
      Memory.create_node(uid, ["internal", "external/10bps"], %{
        content: "10bps project data",
        embedding: @embedding
      })

    {:ok, n_ext_all} =
      Memory.create_node(uid, ["internal", "external/all"], %{
        content: "vacation external all",
        embedding: @embedding
      })

    {:ok, n_kenley} =
      Memory.create_node(uid, ["external/kenley"], %{
        content: "kenley only record",
        embedding: @embedding
      })

    %{
      uid: uid,
      internal: n_internal,
      ext_10bps: n_ext_10bps,
      ext_all: n_ext_all,
      kenley: n_kenley
    }
  end

  # Helper: query nodes filtered by access using DB directly
  defp accessible_ids(user_id, readable_levels) do
    import Ecto.Query
    alias Manfrod.Memory.Node
    alias Manfrod.Repo

    Repo.all(
      from n in Node,
        where: n.user_id == ^user_id,
        where: ^Access.dynamic_where(readable_levels),
        select: n.id
    )
  end

  test "create_node stamps correct access array", ctx do
    assert ctx.internal.access == ["internal"]
    assert ctx.ext_10bps.access == ["internal", "external/10bps"]
    assert ctx.ext_all.access == ["internal", "external/all"]
    assert ctx.kenley.access == ["external/kenley"]
  end

  test "internal reader can see internal nodes but not external/kenley", ctx do
    ids = accessible_ids(ctx.uid, ["internal"])

    assert ctx.internal.id in ids
    assert ctx.ext_10bps.id in ids
    assert ctx.ext_all.id in ids
    refute ctx.kenley.id in ids
  end

  test "external/10bps reader sees 10bps and external/all nodes but not internal-only or kenley", ctx do
    ids = accessible_ids(ctx.uid, ["external/10bps", "external/all"])

    assert ctx.ext_10bps.id in ids
    assert ctx.ext_all.id in ids
    refute ctx.internal.id in ids
    refute ctx.kenley.id in ids
  end

  test "kenley reader only sees kenley nodes", ctx do
    ids = accessible_ids(ctx.uid, ["external/kenley"])

    assert ctx.kenley.id in ids
    refute ctx.internal.id in ids
    refute ctx.ext_10bps.id in ids
    refute ctx.ext_all.id in ids
  end

  test "external/all reader sees all public-scoped nodes but not internal-only", ctx do
    ids = accessible_ids(ctx.uid, ["external/all"])

    assert ctx.ext_all.id in ids
    refute ctx.internal.id in ids
    refute ctx.ext_10bps.id in ids
    refute ctx.kenley.id in ids
  end

  describe "private/<user_id>" do
    setup ctx do
      {:ok, private_node} =
        Memory.create_node(ctx.uid, [Access.private_level(ctx.uid)], %{
          content: "something told to the bot in a DM",
          embedding: @embedding
        })

      %{private: private_node}
    end

    test "DM writes land in the author's private space" do
      user = insert_user!()
      assert Access.resolve_for_write("D0001", user.id) == {:ok, [Access.private_level(user.id)]}
    end

    test "a DM with no known author falls back to internal" do
      assert Access.resolve_for_write("D0001", nil) == {:ok, ["internal"]}
    end

    test "a DM reader sees their own private space, nobody else's", ctx do
      other = insert_user!()
      {:ok, levels} = Access.resolve_for_read(ctx.uid, "D0001")

      assert Access.private_level(ctx.uid) in levels
      refute Access.private_level(other.id) in levels
      assert "internal" in levels
    end

    test "private nodes are invisible to the team and to clients", ctx do
      refute ctx.private.id in accessible_ids(ctx.uid, ["internal"])
      refute ctx.private.id in accessible_ids(ctx.uid, ["external/all"])
      assert ctx.private.id in accessible_ids(ctx.uid, [Access.private_level(ctx.uid)])
    end

    test "one person's private space is not readable by another person", ctx do
      other = insert_user!()
      refute ctx.private.id in accessible_ids(ctx.uid, [Access.private_level(other.id)])
    end

    test "escalating private → internal makes it visible to the team", ctx do
      levels = [Access.private_level(ctx.uid), "internal"]

      assert {:ok, node} = Memory.escalate_note_access(ctx.private.id, "internal", levels)
      assert "internal" in node.access
      # The owner keeps seeing it in their own space
      assert Access.private_level(ctx.uid) in node.access
      assert ctx.private.id in accessible_ids(ctx.uid, ["internal"])
    end

    test "escalating private → external/all works (absences shared with clients)", ctx do
      levels = [Access.private_level(ctx.uid), "internal"]

      assert {:ok, node} = Memory.escalate_note_access(ctx.private.id, "external/all", levels)
      assert "external/all" in node.access
      assert ctx.private.id in accessible_ids(ctx.uid, ["external/all"])
    end

    test "a context without internal access cannot escalate a private note", ctx do
      assert {:error, :external_channel_escalation_not_allowed} =
               Memory.escalate_note_access(ctx.private.id, "internal", ["external/10bps"])
    end

    test "escalating to a level the note already has is rejected", ctx do
      levels = [Access.private_level(ctx.uid), "internal"]

      assert {:ok, _node} = Memory.escalate_note_access(ctx.private.id, "internal", levels)

      assert {:error, :already_accessible} =
               Memory.escalate_note_access(ctx.private.id, "internal", levels)
    end

    test "private is not a valid escalation target", ctx do
      other = insert_user!()
      levels = [Access.private_level(ctx.uid), "internal"]

      assert {:error, :invalid_escalation_level} =
               Memory.escalate_note_access(ctx.private.id, Access.private_level(other.id), levels)
    end
  end
end
