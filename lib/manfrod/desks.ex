defmodule Manfrod.Desks do
  @moduledoc """
  Desk booking: desk definitions (location, equipment, map placement) and
  per-date reservations.

  Desks with `permanent_owner` set are excluded from ad-hoc reservation —
  they're always occupied by that fixed person, so callers never need a
  `desk_reservations` row for them (see `reserve_desk/4`).
  """

  import Ecto.Query

  alias Manfrod.Desks.{Desk, DeskReservation}
  alias Manfrod.Repo

  # --- Desks ---

  @doc """
  List desks. By default only active ones, ordered by label.

  ## Options
    * `:include_inactive` - include deactivated desks. Default: false.
  """
  def list_desks(opts \\ []) do
    query =
      if Keyword.get(opts, :include_inactive, false) do
        Desk
      else
        from(d in Desk, where: d.active == true)
      end

    query
    |> order_by([d], asc: d.label)
    |> Repo.all()
  end

  def get_desk_by_label(label) do
    Repo.one(from d in Desk, where: d.label == ^String.trim(label))
  end

  def create_desk(attrs) do
    %Desk{}
    |> Desk.changeset(attrs)
    |> Repo.insert()
  end

  def update_desk(%Desk{} = desk, attrs) do
    desk
    |> Desk.changeset(attrs)
    |> Repo.update()
  end

  def deactivate_desk(%Desk{} = desk) do
    update_desk(desk, %{active: false})
  end

  # --- Reservations ---

  @doc """
  Reserve a desk (by label) for a user on a date.

  Fails if the desk doesn't exist or is inactive, is permanently assigned to
  someone, the date is in the past, or the desk is already booked that day.
  """
  def reserve_desk(desk_label, user_id, %Date{} = date, note \\ nil) do
    with {:ok, desk} <- fetch_bookable_desk(desk_label),
         :ok <- validate_not_past(date) do
      %DeskReservation{}
      |> DeskReservation.changeset(%{
        desk_id: desk.id,
        user_id: user_id,
        date: date,
        note: note
      })
      |> Repo.insert()
      |> case do
        {:ok, reservation} -> {:ok, Repo.preload(reservation, [:desk, :user])}
        {:error, changeset} -> {:error, changeset}
      end
    end
  end

  @doc """
  Cancel a user's own reservation for a desk on a date.
  """
  def cancel_reservation(user_id, desk_label, %Date{} = date) do
    with {:ok, desk} <- fetch_desk(desk_label) do
      case Repo.one(
             from r in DeskReservation,
               where: r.desk_id == ^desk.id and r.date == ^date and r.user_id == ^user_id
           ) do
        nil -> {:error, :not_found}
        reservation -> Repo.delete(reservation)
      end
    end
  end

  @doc """
  List all reservations for a date, preloaded with desk and user.
  """
  def list_reservations_for_date(%Date{} = date) do
    Repo.all(
      from r in DeskReservation,
        where: r.date == ^date,
        preload: [:desk, :user],
        order_by: [asc: r.inserted_at]
    )
  end

  @doc """
  List a user's upcoming (today or later) reservations, preloaded with desk.
  """
  def list_user_reservations(user_id) do
    today = Date.utc_today()

    Repo.all(
      from r in DeskReservation,
        where: r.user_id == ^user_id and r.date >= ^today,
        preload: [:desk],
        order_by: [asc: r.date]
    )
  end

  # Private

  defp fetch_desk(label) do
    case get_desk_by_label(label) do
      nil -> {:error, :not_found}
      desk -> {:ok, desk}
    end
  end

  defp fetch_bookable_desk(label) do
    with {:ok, desk} <- fetch_desk(label) do
      cond do
        not desk.active -> {:error, :inactive}
        not is_nil(desk.permanent_owner) -> {:error, {:permanent_owner, desk.permanent_owner}}
        true -> {:ok, desk}
      end
    end
  end

  defp validate_not_past(date) do
    if Date.compare(date, Date.utc_today()) == :lt do
      {:error, :past_date}
    else
      :ok
    end
  end
end
