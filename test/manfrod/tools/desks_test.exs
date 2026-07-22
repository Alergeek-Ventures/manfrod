defmodule Manfrod.Tools.DesksTest do
  use Manfrod.DataCase

  alias Manfrod.Tools.Desks, as: DesksTool

  @moduletag :db

  @no_channel %{channel: nil, ts: nil}

  defp run(name, user_id, args, msg_ctx \\ @no_channel) do
    tool =
      %{user_id: user_id, msg_ctx: msg_ctx}
      |> DesksTool.definitions()
      |> Enum.find(&(&1.name == name))

    ReqLLM.Tool.execute(tool, args)
  end

  describe "reserve_desk / cancel_desk_reservation" do
    test "reserves and then reports the conflict on a second attempt" do
      desk = insert_desk!(%{label: "A1"})
      user_id = test_user_id()

      assert {:ok, msg} = run("reserve_desk", user_id, %{desk_label: desk.label, date: "2026-08-01"})
      assert msg =~ "Reserved desk A1"

      other = insert_user!()

      assert {:ok, msg} =
               run("reserve_desk", other.id, %{desk_label: desk.label, date: "2026-08-01"})

      assert msg =~ "already booked"
    end

    test "rejects an invalid date without crashing" do
      desk = insert_desk!(%{label: "A1"})

      assert {:ok, msg} =
               run("reserve_desk", test_user_id(), %{desk_label: desk.label, date: "not-a-date"})

      assert msg =~ "Invalid date"
    end

    test "cancel only removes the caller's own reservation" do
      desk = insert_desk!(%{label: "A1"})
      user_id = test_user_id()
      {:ok, _} = run("reserve_desk", user_id, %{desk_label: desk.label, date: "2026-08-01"})

      other = insert_user!()

      assert {:ok, msg} =
               run("cancel_desk_reservation", other.id, %{
                 desk_label: desk.label,
                 date: "2026-08-01"
               })

      assert msg =~ "don't have a reservation"

      assert {:ok, msg} =
               run("cancel_desk_reservation", user_id, %{
                 desk_label: desk.label,
                 date: "2026-08-01"
               })

      assert msg =~ "Cancelled"
    end
  end

  describe "admin-only desk management" do
    test "add_desk refuses a non-admin" do
      user = insert_user!(%{email: "someone@example.com"})

      assert {:ok, msg} = run("add_desk", user.id, %{label: "Z1"})
      assert msg =~ "Tylko admin"
      assert Manfrod.Desks.get_desk_by_label("Z1") == nil
    end

    test "add_desk succeeds for an admin" do
      admin_email = Application.get_env(:manfrod, :admin_emails) |> List.first()
      admin = Manfrod.Accounts.get_user_by_email(admin_email) || insert_user!(%{email: admin_email})

      assert {:ok, msg} =
               run("add_desk", admin.id, %{label: "Z1", equipment: "usb-c,mac_mini"})

      assert msg =~ "Added desk 'Z1'"

      desk = Manfrod.Desks.get_desk_by_label("Z1")
      assert desk.equipment == ["usb-c", "mac_mini"]
    end

    test "deactivate_desk refuses a non-admin" do
      desk = insert_desk!(%{label: "Z2"})
      user = insert_user!(%{email: "someone@example.com"})

      assert {:ok, msg} = run("deactivate_desk", user.id, %{label: desk.label})
      assert msg =~ "Tylko admin"
    end
  end

  describe "show_desk_map" do
    test "refuses outside a Slack channel" do
      assert {:ok, msg} = run("show_desk_map", test_user_id(), %{})
      assert msg =~ "Can't post the map"
    end

    test "reports a friendly error when the base map image is missing" do
      assert {:ok, msg} =
               run("show_desk_map", test_user_id(), %{}, %{channel: "C123", ts: "1"})

      assert msg =~ "Could not render/post the desk map"
    end
  end
end
