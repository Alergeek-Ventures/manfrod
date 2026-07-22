# Generates the static desk map base image (priv/static/desk_maps/office.png)
# and sets each bookable desk's map_x/map_y to where Manfrod.DeskMap overlays
# the occupant's name tag at render time.
#
# Desk label, equipment, and permanent-owner names don't change day to day,
# so they're drawn directly into this base image (matching the office
# layout as sketched) — only who's sitting there each day is dynamic, and
# that's composited on top at request time, not here.
#
# Re-run after `mix run priv/repo/seeds.exs` if the office layout changes:
#
#     mix run priv/repo/generate_desk_map.exs

box_w = 160
box_h = 90

# {label, top-left x, top-left y, box text lines, permanent?}
desks = [
  {"T1", 260, 100, ["T1", "usb-c"], false},
  {"T2", 460, 100, ["T2", "hdmi"], false},
  {"T3", 660, 100, ["T3", "mac mini"], false},
  {"T4", 260, 210, ["T4", "hdmi"], false},
  {"T5", 460, 210, ["T5", "hdmi"], false},
  {"T6", 660, 210, ["T6", "mac mini"], false},
  {"B1", 80, 390, ["B1", "usb-c"], false},
  {"B2", 260, 390, ["B2", "brak monitora"], false},
  {"B3", 80, 500, ["B3", "usb-c", "zwykle: Staszek"], false},
  {"B4", 260, 500, ["B4", "usb-c"], false},
  {"Agata", 560, 440, ["Agata"], true},
  {"Franek", 760, 440, ["Franek"], true}
]

# Extra top margin (vs. box_h + a couple rows) leaves room for
# Manfrod.DeskMap's date-stamp header, composited at request time.
{:ok, canvas} = Image.new(1000, 660, color: :white)

canvas =
  Enum.reduce(desks, canvas, fn {_label, x, y, lines, permanent?}, image ->
    fill_color = if permanent?, do: "#4A5568", else: "#EDF2F7"
    text_color = if permanent?, do: "white", else: "black"

    {:ok, box} =
      Image.Shape.rect(box_w, box_h,
        fill_color: fill_color,
        stroke_color: "#2D3748",
        stroke_width: 2,
        opacity: 1.0
      )

    {:ok, image} = Image.compose(image, box, x: x, y: y)

    {:ok, label} =
      Image.Text.text(Enum.join(lines, "\n"),
        font_size: 14,
        text_fill_color: text_color,
        align: :center,
        width: box_w - 10
      )

    {:ok, image} = Image.compose(image, label, x: x + 5, y: y + 10)
    image
  end)

File.mkdir_p!("priv/static/desk_maps")
Image.write!(canvas, "priv/static/desk_maps/office.png")

# Bottom-of-box anchor for the dynamic occupant name tag. Permanently
# assigned desks (Agata/Franek) get no map coordinates — their owner is
# already baked into the image above, there's nothing to overlay.
bookable_positions = %{
  "T1" => {265, 160},
  "T2" => {465, 160},
  "T3" => {665, 160},
  "T4" => {265, 270},
  "T5" => {465, 270},
  "T6" => {665, 270},
  "B1" => {85, 450},
  "B2" => {265, 450},
  "B3" => {85, 560},
  "B4" => {265, 560}
}

for {label, {x, y}} <- bookable_positions do
  case Manfrod.Desks.get_desk_by_label(label) do
    nil ->
      IO.puts("skip #{label}: desk not found (run seeds.exs first)")

    desk ->
      {:ok, _} = Manfrod.Desks.update_desk(desk, %{map_x: x, map_y: y})
  end
end

IO.puts("Wrote priv/static/desk_maps/office.png and set map_x/map_y for bookable desks.")
