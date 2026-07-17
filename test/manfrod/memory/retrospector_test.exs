defmodule Manfrod.Memory.RetrospectorTest do
  use Manfrod.DataCase

  alias Manfrod.Memory
  alias Manfrod.Memory.{Link, Node, Retrospector}

  @moduletag :db

  # The test sandbox runs on top of the local dev database, so unrelated
  # nodes (and even unrelated duplicate groups) may exist. Contents are
  # unique per run and assertions target our own nodes, never global counts.
  defp unique_content(label), do: "#{label} #{System.unique_integer([:positive])}"

  describe "merge_exact_duplicates/0" do
    test "merges nodes with identical content, keeping the best-connected one" do
      content = unique_content("Duplicated fact")
      neighbor = insert_node!(%{content: unique_content("Neighbor fact")})
      connected = insert_node!(%{content: content})
      duplicate = insert_node!(%{content: content})
      insert_link!(connected, neighbor)

      result = Retrospector.merge_exact_duplicates()

      assert result.deleted >= 1
      assert Repo.get(Node, connected.id)
      refute Repo.get(Node, duplicate.id)
    end

    test "treats content differing only in surrounding whitespace as duplicate" do
      content = unique_content("Trimmed fact")
      a = insert_node!(%{content: content})
      b = insert_node!(%{content: "  #{content}  "})

      Retrospector.merge_exact_duplicates()

      surviving = [a.id, b.id] |> Enum.filter(&Repo.get(Node, &1))
      assert length(surviving) == 1
    end

    test "repoints the duplicate's links onto the survivor, keeping context" do
      content = unique_content("Duplicated fact")
      neighbor = insert_node!(%{content: unique_content("Neighbor fact")})
      connected = insert_node!(%{content: content})
      duplicate = insert_node!(%{content: content})
      other = insert_node!(%{content: unique_content("Other fact")})
      insert_link!(connected, neighbor)

      {:ok, _} =
        %Link{}
        |> Link.changeset(%{node_a_id: duplicate.id, node_b_id: other.id, context: "why"})
        |> Repo.insert()

      Retrospector.merge_exact_duplicates()

      linked = Memory.get_node_links_with_context(test_user_id(), connected.id)
      linked_ids = Enum.map(linked, fn {n, _ctx} -> n.id end)

      assert neighbor.id in linked_ids
      assert other.id in linked_ids
      assert {_, "why"} = Enum.find(linked, fn {n, _} -> n.id == other.id end)
    end

    test "does not create a self-link when duplicates are linked to each other" do
      content = unique_content("Self-link candidate")
      a = insert_node!(%{content: content})
      b = insert_node!(%{content: content})
      insert_link!(a, b)

      Retrospector.merge_exact_duplicates()

      survivor_id = if Repo.get(Node, a.id), do: a.id, else: b.id
      assert Memory.get_node_links(test_user_id(), survivor_id) == []

      refute Repo.one(
               from(l in Link,
                 where: l.node_a_id == ^survivor_id and l.node_b_id == ^survivor_id
               )
             )
    end

    test "prefers a processed node over a slipbox node at equal link counts" do
      content = unique_content("Processed wins")
      now = DateTime.utc_now() |> DateTime.truncate(:second)
      slipbox = insert_node!(%{content: content})
      processed = insert_node!(%{content: content, processed_at: now})

      Retrospector.merge_exact_duplicates()

      assert Repo.get(Node, processed.id)
      refute Repo.get(Node, slipbox.id)
    end

    test "does not merge across different access buckets" do
      content = unique_content("Bucket-scoped fact")
      a = insert_node!(%{content: content, access: ["internal"]})
      b = insert_node!(%{content: content, access: ["external/acme"]})

      Retrospector.merge_exact_duplicates()

      assert Repo.get(Node, a.id)
      assert Repo.get(Node, b.id)
    end

    test "leaves unique nodes untouched" do
      a = insert_node!(%{content: unique_content("Unique fact")})
      b = insert_node!(%{content: unique_content("Unique fact")})

      Retrospector.merge_exact_duplicates()

      assert Repo.get(Node, a.id)
      assert Repo.get(Node, b.id)
    end
  end
end
