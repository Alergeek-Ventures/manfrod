defmodule Manfrod.Slack.LookupCacheTest do
  use ExUnit.Case, async: false

  alias Manfrod.Slack.LookupCache

  setup do
    unless Process.whereis(LookupCache), do: start_supervised!(LookupCache)

    %{key: {:user, "U#{System.unique_integer([:positive])}"}}
  end

  test "reuses a successful lookup", %{key: key} do
    assert {:ok, "Ola"} = LookupCache.fetch(key, fn -> {:ok, "Ola"} end)
    assert {:ok, "Ola"} = LookupCache.fetch(key, fn -> flunk("looked up again") end)
  end

  test "does not cache a failed lookup", %{key: key} do
    assert {:error, :ratelimited} = LookupCache.fetch(key, fn -> {:error, :ratelimited} end)
    assert {:ok, "Ola"} = LookupCache.fetch(key, fn -> {:ok, "Ola"} end)
  end
end
