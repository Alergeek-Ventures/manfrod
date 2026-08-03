defmodule Manfrod.AccountsTest do
  use Manfrod.DataCase

  alias Manfrod.Accounts
  alias Manfrod.Accounts.User

  @moduletag :db

  describe "full_name/1" do
    test "returns a stored name that already has a surname untouched" do
      user = insert_user!(%{name: "Kamil Marczak"})

      assert Accounts.full_name(user) == "Kamil Marczak"
      assert Accounts.full_name(user.id) == "Kamil Marczak"
    end

    test "collapses surrounding whitespace when deciding, not when returning" do
      user = insert_user!(%{name: "Anna  Kowalska"})

      assert Accounts.full_name(user) == "Anna  Kowalska"
    end

    test "returns nil for a user that does not exist" do
      assert Accounts.full_name(nil) == nil
      assert Accounts.full_name(Ecto.UUID.generate()) == nil
    end

    # The repair path asks Slack for the profile's first/last name, so it is
    # only exercised where a Slack call is acceptable. What is pinned here is
    # that a user with no Slack identity to repair from degrades to the stored
    # first name rather than blowing up or returning nothing.
    test "falls back to a bare first name when there is nothing to repair from" do
      assert Accounts.full_name(%User{name: "Kamil", slack_id: nil}) == "Kamil"
      assert Accounts.full_name(%User{name: nil, slack_id: nil}) == nil
    end
  end
end
