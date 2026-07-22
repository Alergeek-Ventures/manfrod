defmodule Manfrod.DesksTest do
  use Manfrod.DataCase

  alias Manfrod.Desks

  @moduletag :db

  describe "list_desks/1" do
    test "lists only active desks by default" do
      active = insert_desk!(%{label: "Active"})
      inactive = insert_desk!(%{label: "Inactive", active: false})

      labels = Desks.list_desks() |> Enum.map(& &1.label)

      assert active.label in labels
      refute inactive.label in labels
    end

    test "include_inactive: true includes deactivated desks" do
      inactive = insert_desk!(%{label: "Inactive", active: false})

      labels = Desks.list_desks(include_inactive: true) |> Enum.map(& &1.label)

      assert inactive.label in labels
    end
  end

  describe "reserve_desk/4" do
    test "books a desk for a user on a date" do
      desk = insert_desk!(%{label: "A1"})
      user = test_user()
      date = Date.utc_today()

      assert {:ok, reservation} = Desks.reserve_desk(desk.label, user.id, date)
      assert reservation.desk.id == desk.id
      assert reservation.user.id == user.id
      assert reservation.date == date
    end

    test "fails when the desk is already booked that day" do
      desk = insert_desk!(%{label: "A1"})
      other_user = insert_user!()
      date = Date.utc_today()

      {:ok, _} = Desks.reserve_desk(desk.label, other_user.id, date)

      assert {:error, %Ecto.Changeset{}} = Desks.reserve_desk(desk.label, test_user_id(), date)
    end

    test "fails for an unknown desk label" do
      assert {:error, :not_found} = Desks.reserve_desk("nope", test_user_id(), Date.utc_today())
    end

    test "fails for an inactive desk" do
      desk = insert_desk!(%{label: "A1", active: false})
      assert {:error, :inactive} = Desks.reserve_desk(desk.label, test_user_id(), Date.utc_today())
    end

    test "fails for a permanently assigned desk" do
      desk = insert_desk!(%{permanent_owner: "Agata"})

      assert {:error, {:permanent_owner, "Agata"}} =
               Desks.reserve_desk(desk.label, test_user_id(), Date.utc_today())
    end

    test "fails for a past date" do
      desk = insert_desk!(%{label: "A1"})
      yesterday = Date.add(Date.utc_today(), -1)

      assert {:error, :past_date} = Desks.reserve_desk(desk.label, test_user_id(), yesterday)
    end

    test "replaces the user's existing reservation on the same date instead of adding a second one" do
      desk_a = insert_desk!(%{label: "A1"})
      desk_b = insert_desk!(%{label: "A2"})
      date = Date.utc_today()
      user_id = test_user_id()

      {:ok, _} = Desks.reserve_desk(desk_a.label, user_id, date)
      assert {:ok, reservation} = Desks.reserve_desk(desk_b.label, user_id, date)

      assert reservation.desk.id == desk_b.id

      dates_reservations = Desks.list_reservations_for_date(date)
      assert length(dates_reservations) == 1
      assert hd(dates_reservations).desk.id == desk_b.id
    end

    test "re-reserving the same desk on the same date just updates it (no duplicate)" do
      desk = insert_desk!(%{label: "A1"})
      date = Date.utc_today()
      user_id = test_user_id()

      {:ok, _} = Desks.reserve_desk(desk.label, user_id, date, "first note")
      assert {:ok, reservation} = Desks.reserve_desk(desk.label, user_id, date, "second note")

      assert reservation.note == "second note"
      assert length(Desks.list_reservations_for_date(date)) == 1
    end
  end

  describe "cancel_reservation/3" do
    test "cancels the caller's own reservation" do
      desk = insert_desk!(%{label: "A1"})
      date = Date.utc_today()
      {:ok, _} = Desks.reserve_desk(desk.label, test_user_id(), date)

      assert {:ok, _} = Desks.cancel_reservation(test_user_id(), desk.label, date)
      assert Desks.list_reservations_for_date(date) == []
    end

    test "does not cancel another user's reservation" do
      desk = insert_desk!(%{label: "A1"})
      other_user = insert_user!()
      date = Date.utc_today()
      {:ok, _} = Desks.reserve_desk(desk.label, other_user.id, date)

      assert {:error, :not_found} = Desks.cancel_reservation(test_user_id(), desk.label, date)
    end
  end

  describe "list_reservations_for_date/1" do
    test "preloads desk and user" do
      desk = insert_desk!(%{label: "A1"})
      user = test_user()
      {:ok, _} = Desks.reserve_desk(desk.label, user.id, Date.utc_today())

      [reservation] = Desks.list_reservations_for_date(Date.utc_today())
      assert reservation.desk.label == "A1"
      assert reservation.user.id == user.id
    end
  end
end
