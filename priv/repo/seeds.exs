# Script for populating the database. You can run it as:
#
#     mix run priv/repo/seeds.exs
#
# Inside the script, you can read and write to any of your
# repositories directly:
#
#     Manfrod.Repo.insert!(%Manfrod.SomeSchema{})
#
# We recommend using the bang functions (`insert!`, `update!`
# and so on) as they will fail if something goes wrong.

# Desk layout as initially sketched: a 2x3 table, a 2x2 cluster, and two
# permanently-assigned desks. `map_x`/`map_y` are intentionally left unset —
# they depend on the pixel coordinates of the final base map image (see
# Manfrod.DeskMap), which doesn't exist yet. An admin fills them in later via
# the update_desk tool once priv/static/desk_maps/office.png is in place.
# Safe to re-run: create_desk is a no-op (via unique_constraint) for labels
# that already exist.
desks = [
  %{label: "T1", equipment: ["usb-c"]},
  %{label: "T2", equipment: ["hdmi"]},
  %{label: "T3", equipment: ["mac_mini"]},
  %{label: "T4", equipment: ["hdmi"]},
  %{label: "T5", equipment: ["hdmi"]},
  %{label: "T6", equipment: ["mac_mini"]},
  %{label: "B1", equipment: ["usb-c"]},
  %{label: "B2", equipment: ["no_monitor"]},
  %{label: "B3", equipment: ["usb-c"], location_note: "zwykle: Staszek"},
  %{label: "B4", equipment: ["usb-c"]},
  %{label: "Agata", equipment: [], permanent_owner: "Agata"},
  %{label: "Franek", equipment: [], permanent_owner: "Franek"}
]

for attrs <- desks do
  case Manfrod.Desks.create_desk(attrs) do
    {:ok, _desk} -> :ok
    {:error, %Ecto.Changeset{errors: [label: _]}} -> :ok
  end
end
