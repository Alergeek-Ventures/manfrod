defmodule Manfrod.DeskMap do
  @moduledoc """
  Renders the office desk map: opens the static base floor-plan image
  (drawn once by `priv/repo/generate_desk_map.exs`, not regenerated per
  request) and composites a name tag onto it for every desk that's reserved
  on the given date. Desk labels, equipment, and permanent owners don't
  change day to day, so they're baked into the base image itself — only the
  occupant is dynamic. Desks without `map_x`/`map_y` are skipped here but
  still fully bookable via `Manfrod.Desks` / the desk-booking tools.
  """

  alias Manfrod.Desks
  alias Manfrod.Slack.API

  @doc """
  Render the desk map as a PNG binary for a date.
  """
  @spec render_png(Date.t()) :: {:ok, binary()} | {:error, term()}
  def render_png(%Date{} = date) do
    with {:ok, base} <- open_base_image() do
      reservations =
        date
        |> Desks.list_reservations_for_date()
        |> Enum.filter(&(&1.desk.map_x && &1.desk.map_y))

      with {:ok, composed} <- compose_labels(base, reservations),
           {:ok, headed} <- compose_date_header(composed, date) do
        Image.write(headed, :memory, suffix: ".png")
      end
    end
  end

  @doc """
  Render and post the desk map for a date to a Slack channel.
  """
  @spec post_map(String.t(), Date.t(), String.t() | nil) :: {:ok, map()} | {:error, term()}
  def post_map(_channel, _date, nil), do: {:error, :missing_bot_token}

  def post_map(channel, %Date{} = date, bot_token) do
    with {:ok, png} <- render_png(date) do
      API.upload_file(bot_token, channel, "biurka-#{Date.to_iso8601(date)}.png", png)
    end
  end

  # Private

  defp compose_labels(base, reservations) do
    Enum.reduce_while(reservations, {:ok, base}, fn reservation, {:ok, image} ->
      with {:ok, tag} <- name_tag(reservation.user.name),
           {:ok, composed} <-
             Image.compose(image, tag, x: reservation.desk.map_x, y: reservation.desk.map_y) do
        {:cont, {:ok, composed}}
      else
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp name_tag(name) do
    Image.Text.text(name,
      font_size: 14,
      text_fill_color: "white",
      background_fill_color: "#2F855A",
      background_fill_opacity: 0.9,
      padding: [6, 3]
    )
  end

  # So a screenshot/forward of the map doesn't leave people guessing which
  # day it's for.
  defp compose_date_header(image, date) do
    day_name = Calendar.strftime(date, "%A")

    with {:ok, header} <-
           Image.Text.text("Biurka — #{Date.to_iso8601(date)} (#{day_name})",
             font_size: 22,
             text_fill_color: "black"
           ) do
      Image.compose(image, header, x: 20, y: 15)
    end
  end

  defp open_base_image do
    path = Application.get_env(:manfrod, :desk_map_image_path) || default_image_path()

    if File.exists?(path) do
      Image.open(path)
    else
      {:error, {:base_image_not_found, path}}
    end
  end

  # Resolved at runtime (not a module attribute) — see Manfrod.Skills for why
  # Application.app_dir/2 must be called fresh rather than baked in at
  # compile time under a release.
  defp default_image_path do
    Application.app_dir(:manfrod, "priv/static/desk_maps/office.png")
  end
end
