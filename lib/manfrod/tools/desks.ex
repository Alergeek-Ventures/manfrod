defmodule Manfrod.Tools.Desks do
  @moduledoc """
  Desk booking tools for the live agent. Reservation/lookup tools are open to
  everyone; desk-definition tools (add/update/deactivate) are admin-only —
  same `admin_emails` gate as the `/status-manfrod` slash command
  (`Manfrod.Slack.EventHandler.admin_slack_user?/1`), checked here via the
  caller's account email since tools only carry `user_id`.

  Usage instructions live in the `desk-booking` skill
  (priv/skills/desk-booking/SKILL.md); this module only implements the tools.
  """

  alias Manfrod.Accounts
  alias Manfrod.Desks

  def definitions(%{user_id: user_id, msg_ctx: msg_ctx}) do
    [
      ReqLLM.Tool.new!(
        name: "list_desks",
        description:
          "List all desks with their equipment and booking status for a date (default today).",
        parameter_schema: [
          date: [type: :string, doc: "ISO8601 date (YYYY-MM-DD), default today"]
        ],
        callback: fn args -> list_desks(args) end
      ),
      ReqLLM.Tool.new!(
        name: "reserve_desk",
        description: "Reserve a desk for yourself on a specific date.",
        parameter_schema: [
          desk_label: [type: :string, required: true, doc: "Desk label, e.g. 'A5'"],
          date: [type: :string, required: true, doc: "ISO8601 date (YYYY-MM-DD)"],
          note: [type: :string, doc: "Optional note"]
        ],
        callback: fn args -> reserve_desk(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "cancel_desk_reservation",
        description: "Cancel your own desk reservation for a specific date.",
        parameter_schema: [
          desk_label: [type: :string, required: true, doc: "Desk label, e.g. 'A5'"],
          date: [type: :string, required: true, doc: "ISO8601 date (YYYY-MM-DD)"]
        ],
        callback: fn args -> cancel_desk_reservation(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_desk_reservations",
        description: "List who has which desk reserved on a date (default today), as text.",
        parameter_schema: [
          date: [type: :string, doc: "ISO8601 date (YYYY-MM-DD), default today"]
        ],
        callback: fn args -> list_desk_reservations(args) end
      ),
      ReqLLM.Tool.new!(
        name: "show_desk_map",
        description:
          "Render the office desk map as an image for a date (default today) and post it to Slack. Posts to this channel by default, or to channel_id if given.",
        parameter_schema: [
          date: [type: :string, doc: "ISO8601 date (YYYY-MM-DD), default today"],
          channel_id: [
            type: :string,
            doc: "Slack channel ID to post to instead of the current channel, e.g. 'C087QF130R3'"
          ]
        ],
        callback: fn args -> show_desk_map(msg_ctx, args) end
      ),
      ReqLLM.Tool.new!(
        name: "add_desk",
        description:
          "Admin only. Add a new desk to the office layout (location, equipment, map position).",
        parameter_schema: [
          label: [type: :string, required: true, doc: "Desk label, e.g. 'A5'"],
          location_note: [type: :string, doc: "Free-text location, e.g. 'przy oknie'"],
          equipment: [
            type: :string,
            doc: "Comma-separated equipment tags, e.g. 'usb-c,mac_mini'"
          ],
          map_x: [type: :integer, doc: "Pixel x on the base map image"],
          map_y: [type: :integer, doc: "Pixel y on the base map image"],
          permanent_owner: [
            type: :string,
            doc: "If set, desk is always occupied by this person and never bookable"
          ]
        ],
        callback: fn args -> add_desk(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "update_desk",
        description:
          "Admin only. Update an existing desk's location, equipment, map position, or permanent owner.",
        parameter_schema: [
          label: [type: :string, required: true, doc: "Existing desk label to update"],
          location_note: [type: :string, doc: "New free-text location"],
          equipment: [type: :string, doc: "New comma-separated equipment tags"],
          map_x: [type: :integer, doc: "New pixel x on the base map image"],
          map_y: [type: :integer, doc: "New pixel y on the base map image"],
          permanent_owner: [
            type: :string,
            doc: "Set to permanently assign the desk, or leave unset to keep it as-is"
          ]
        ],
        callback: fn args -> update_desk(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "deactivate_desk",
        description: "Admin only. Remove a desk from the bookable layout (soft delete).",
        parameter_schema: [
          label: [type: :string, required: true, doc: "Desk label to deactivate"]
        ],
        callback: fn args -> deactivate_desk(user_id, args) end
      )
    ]
  end

  # --- Open tools ---

  defp list_desks(args) do
    with_date(args, fn date ->
      desks = Desks.list_desks()
      by_desk_id = date |> Desks.list_reservations_for_date() |> Map.new(&{&1.desk_id, &1})

      if Enum.empty?(desks) do
        {:ok, "No desks configured yet."}
      else
        lines = Enum.map(desks, &format_desk_line(&1, Map.get(by_desk_id, &1.id)))
        {:ok, "Desks (#{Date.to_iso8601(date)}):\n#{Enum.join(lines, "\n")}"}
      end
    end)
  end

  defp reserve_desk(user_id, %{desk_label: label} = args) do
    with_date(args, fn date ->
      case Desks.reserve_desk(label, user_id, date, Map.get(args, :note)) do
        {:ok, reservation} ->
          {:ok, "Reserved desk #{reservation.desk.label} for #{Date.to_iso8601(date)}."}

        {:error, :not_found} ->
          {:ok, "No desk found with label '#{label}'."}

        {:error, :inactive} ->
          {:ok, "Desk '#{label}' is no longer available."}

        {:error, {:permanent_owner, owner}} ->
          {:ok, "Desk '#{label}' is permanently assigned to #{owner} and can't be booked."}

        {:error, :past_date} ->
          {:ok, "Can't reserve a desk in the past. Provide today or a future date."}

        {:error, %Ecto.Changeset{}} ->
          existing =
            Desks.list_reservations_for_date(date) |> Enum.find(&(&1.desk.label == label))

          if existing do
            {:ok,
             "Desk '#{label}' is already booked by #{existing.user.name} on #{Date.to_iso8601(date)}."}
          else
            {:ok, "Could not reserve desk '#{label}' — invalid request."}
          end
      end
    end)
  end

  defp cancel_desk_reservation(user_id, %{desk_label: label} = args) do
    with_date(args, fn date ->
      case Desks.cancel_reservation(user_id, label, date) do
        {:ok, _} ->
          {:ok, "Cancelled your reservation for desk '#{label}' on #{Date.to_iso8601(date)}."}

        {:error, :not_found} ->
          {:ok, "You don't have a reservation for desk '#{label}' on that date."}
      end
    end)
  end

  defp list_desk_reservations(args) do
    with_date(args, fn date ->
      reservations = Desks.list_reservations_for_date(date)
      permanent = Desks.list_desks() |> Enum.filter(&(&1.permanent_owner not in [nil, ""]))

      if Enum.empty?(reservations) and Enum.empty?(permanent) do
        {:ok, "No desk reservations for #{Date.to_iso8601(date)}."}
      else
        permanent_lines =
          Enum.map(permanent, &"- #{&1.label}: #{&1.permanent_owner} (stałe przypisanie)")

        reservation_lines =
          Enum.map(reservations, &"- #{&1.desk.label}: #{&1.user.name}#{note_suffix(&1.note)}")

        lines = permanent_lines ++ reservation_lines

        {:ok, "Desk reservations (#{Date.to_iso8601(date)}):\n#{Enum.join(lines, "\n")}"}
      end
    end)
  end

  defp show_desk_map(msg_ctx, args) do
    case Map.get(args, :channel_id, msg_ctx.channel) do
      nil ->
        {:ok, "Can't post the map outside a Slack channel."}

      channel ->
        with_date(args, fn date ->
          bot_token = Application.get_env(:manfrod, :slack_bot_token)

          case Manfrod.DeskMap.post_map(channel, date, bot_token) do
            {:ok, _} -> {:ok, "Posted the desk map for #{Date.to_iso8601(date)}."}
            {:error, reason} -> {:ok, "Could not render/post the desk map: #{inspect(reason)}"}
          end
        end)
    end
  end

  # --- Admin-only tools ---

  defp add_desk(user_id, args) do
    with :ok <- require_admin(user_id) do
      attrs =
        args
        |> Map.take([:label, :location_note, :map_x, :map_y, :permanent_owner])
        |> maybe_split_equipment(args)

      case Desks.create_desk(attrs) do
        {:ok, desk} -> {:ok, "Added desk '#{desk.label}'."}
        {:error, changeset} -> {:ok, "Could not add desk: #{inspect(changeset.errors)}"}
      end
    end
  end

  defp update_desk(user_id, %{label: label} = args) do
    with :ok <- require_admin(user_id) do
      case Desks.get_desk_by_label(label) do
        nil ->
          {:ok, "No desk found with label '#{label}'."}

        desk ->
          attrs =
            args
            |> Map.drop([:label])
            |> Map.take([:location_note, :map_x, :map_y, :permanent_owner])
            |> maybe_split_equipment(args)

          case Desks.update_desk(desk, attrs) do
            {:ok, updated} -> {:ok, "Updated desk '#{updated.label}'."}
            {:error, changeset} -> {:ok, "Could not update desk: #{inspect(changeset.errors)}"}
          end
      end
    end
  end

  defp deactivate_desk(user_id, %{label: label}) do
    with :ok <- require_admin(user_id) do
      case Desks.get_desk_by_label(label) do
        nil ->
          {:ok, "No desk found with label '#{label}'."}

        desk ->
          with {:ok, _} <- Desks.deactivate_desk(desk), do: {:ok, "Deactivated desk '#{label}'."}
      end
    end
  end

  # Private

  defp require_admin(user_id) do
    admin_emails = Application.get_env(:manfrod, :admin_emails, [])

    case Accounts.get_user!(user_id) do
      %{email: email} when is_binary(email) ->
        if email in admin_emails, do: :ok, else: {:ok, "Tylko admin może zarządzać biurkami."}

      _ ->
        {:ok, "Tylko admin może zarządzać biurkami."}
    end
  end

  defp maybe_split_equipment(attrs, %{equipment: equipment}) when is_binary(equipment) do
    tags =
      equipment
      |> String.split(",", trim: true)
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))

    Map.put(attrs, :equipment, tags)
  end

  defp maybe_split_equipment(attrs, _args), do: attrs

  defp parse_date(nil), do: {:ok, Date.utc_today()}

  defp parse_date(date_string) do
    case Date.from_iso8601(date_string) do
      {:ok, date} -> {:ok, date}
      {:error, _} -> {:error, "Invalid date '#{date_string}'. Use ISO8601 like '2026-07-23'."}
    end
  end

  # Runs `fun.(date)` when the date argument parses, otherwise short-circuits
  # with a friendly `{:ok, message}` tool result (validation failure, not a
  # tool error — mirrors Reminders.set_reminder's handling of bad datetimes).
  defp with_date(args, fun) do
    case parse_date(Map.get(args, :date)) do
      {:ok, date} -> fun.(date)
      {:error, message} -> {:ok, message}
    end
  end

  defp note_suffix(nil), do: ""
  defp note_suffix(""), do: ""
  defp note_suffix(note), do: " — #{note}"

  defp format_desk_line(desk, reservation) do
    equipment = if desk.equipment == [], do: "brak sprzętu", else: Enum.join(desk.equipment, ", ")
    location = if desk.location_note, do: " (#{desk.location_note})", else: ""

    status =
      cond do
        desk.permanent_owner -> "na stałe: #{desk.permanent_owner}"
        reservation -> "zajęte: #{reservation.user.name}"
        true -> "wolne"
      end

    "- #{desk.label}#{location} [#{equipment}] — #{status}"
  end
end
