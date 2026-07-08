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
end
