defmodule Manfrod.Slack.UserContextTest do
  use ExUnit.Case, async: false

  alias Manfrod.Slack.UserContext

  setup do
    # The Slack supervisor already owns a UserContext whenever Slack tokens are
    # configured, so start one only when running without it. Isolation comes
    # from a distinct user id per test rather than from a fresh table.
    unless Process.whereis(UserContext), do: start_supervised!(UserContext)

    %{user: "U#{System.unique_integer([:positive])}"}
  end

  defp names(map), do: fn id -> map[id] end

  describe "put/2 and get/1" do
    test "remembers the last context a user switched to", %{user: user} do
      UserContext.put(user, %{"channel_id" => "C123"})
      UserContext.put(user, %{"channel_id" => "C456", "thread_ts" => "1.0"})

      assert UserContext.get(user) == %{"channel_id" => "C456", "thread_ts" => "1.0"}
    end

    test "an empty or nil context clears the entry rather than storing junk", %{user: user} do
      UserContext.put(user, %{"channel_id" => "C123"})
      UserContext.put(user, nil)

      assert UserContext.get(user) == nil
    end

    test "an unknown user has no context" do
      assert UserContext.get("U_NOBODY") == nil
    end
  end

  describe "describe/2" do
    test "names the channel the user is viewing", %{user: user} do
      UserContext.put(user, %{"channel_id" => "C123"})

      description = UserContext.describe(user, names(%{"C123" => "general"}))

      assert description =~ "#general"
      assert description =~ "C123"
    end

    test "mentions the thread when the user is inside one", %{user: user} do
      UserContext.put(user, %{"channel_id" => "C123", "thread_ts" => "1712345678.000100"})

      description = UserContext.describe(user, names(%{"C123" => "general"}))

      assert description =~ "thread"
      assert description =~ "1712345678.000100"
    end

    # The bot's own DM is the conversation the user is already typing in;
    # describing it as "somewhere else" would only confuse the model.
    test "says nothing when the user is looking at a DM", %{user: user} do
      UserContext.put(user, %{"channel_id" => "D999"})

      assert UserContext.describe(user, names(%{"D999" => "manfrod"})) == nil
    end

    test "falls back to the raw id when the channel name is unknown", %{user: user} do
      UserContext.put(user, %{"channel_id" => "C123"})

      assert UserContext.describe(user, fn _ -> nil end) =~ "C123"
    end

    test "says nothing about a user with no recorded context" do
      assert UserContext.describe("U_NOBODY", names(%{})) == nil
    end
  end
end
