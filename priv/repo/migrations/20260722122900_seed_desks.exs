defmodule Manfrod.Repo.Migrations.SeedDesks do
  @moduledoc """
  Inserts the initial office desk layout (as sketched: a 2x3 table, a 2x2
  cluster, and two permanently-assigned desks). Runs automatically on every
  deploy via `bin/migrate` — unlike `priv/repo/seeds.exs`, which the
  production release never executes. `map_x`/`map_y` are left unset here;
  those depend on the base map image's pixel coordinates and are set once
  by `priv/repo/generate_desk_map.exs`.

  Layout changes later belong in a new migration, not an edit to this one —
  migrations are immutable once applied.
  """
  use Ecto.Migration

  @desks [
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

  def up do
    now = NaiveDateTime.utc_now() |> NaiveDateTime.truncate(:second)

    rows =
      Enum.map(@desks, fn attrs ->
        %{
          id: Ecto.UUID.generate(),
          label: attrs.label,
          equipment: Map.get(attrs, :equipment, []),
          location_note: Map.get(attrs, :location_note),
          permanent_owner: Map.get(attrs, :permanent_owner),
          active: true,
          inserted_at: now,
          updated_at: now
        }
      end)

    repo().insert_all(Manfrod.Desks.Desk, rows, on_conflict: :nothing, conflict_target: :label)
  end

  def down do
    labels = Enum.map(@desks, & &1.label)
    execute("DELETE FROM desks WHERE label IN (#{Enum.map_join(labels, ",", &"'#{&1}'")})")
  end
end
