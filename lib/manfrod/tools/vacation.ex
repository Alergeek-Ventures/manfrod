defmodule Manfrod.Tools.Vacation do
  @moduledoc """
  Vacation/absence reporting tool for the live agent. Usage instructions live
  in the `vacation-tracking` skill (priv/skills/vacation-tracking/SKILL.md);
  this module only implements the tool itself.
  """

  alias Manfrod.Accounts
  alias Manfrod.Memory
  alias Manfrod.Memory.PendingOps
  alias Manfrod.Tools.Support
  alias Manfrod.Voyage

  def definitions(%{user_id: user_id, msg_ctx: msg_ctx}) do
    [
      ReqLLM.Tool.new!(
        name: "report_vacation",
        description:
          "Flag a planned absence/vacation for the background memory to record. " <>
            "The memory saves it and decides on its own whether to propose sharing with all clients. " <>
            "Call whenever the user mentions being absent — do NOT ask the user about client visibility.",
        parameter_schema: [
          start_date: [type: :string, required: true, doc: "Start date ISO8601 (YYYY-MM-DD)"],
          end_date: [type: :string, required: true, doc: "End date ISO8601 (YYYY-MM-DD)"]
        ],
        callback: fn args -> report_vacation(user_id, msg_ctx, args) end
      )
    ]
  end

  defp report_vacation(user_id, msg_ctx, %{start_date: start_date, end_date: end_date}) do
    case Support.flaggable(msg_ctx) do
      {:ok, channel_id, ts} ->
        PendingOps.flag_message(channel_id, ts, "create_absence", %{
          start_date: start_date,
          end_date: end_date,
          content: absence_note(user_id, start_date, end_date)
        })

        {:ok,
         "Zanotowane (#{start_date}..#{end_date}). Pamięć w tle zapisze nieobecność i w razie potrzeby zapyta o udostępnienie klientom."}

      :error ->
        report_vacation_direct(user_id, start_date, end_date)
    end
  end

  defp report_vacation_direct(user_id, start_date, end_date) do
    note = absence_note(user_id, start_date, end_date)
    key = "vacation:#{user_id}:#{start_date}"
    value = "#{start_date}..#{end_date} — #{note}"
    access = ["internal", "external/all"]

    with {:ok, _fact} <- Manfrod.Facts.set_fact(key, value, access, user_id),
         {:ok, embedding} <- Voyage.embed_query(note),
         {:ok, _node} <-
           Memory.create_node(user_id, access, %{content: note, embedding: embedding}) do
      {:ok, "Zapisałem urlop: #{value}"}
    else
      {:error, %Ecto.Changeset{} = changeset} ->
        {:ok, "Błąd zapisu: #{inspect(changeset.errors)}"}

      {:error, e} ->
        {:ok, "Błąd zapisu: #{inspect(e)}"}
    end
  end

  defp absence_note(user_id, start_date, end_date) do
    dates = if start_date == end_date, do: start_date, else: "#{start_date}..#{end_date}"
    "#{user_name(user_id)} bierze urlop #{dates}"
  end

  defp user_name(user_id) do
    case Accounts.get_user(user_id) do
      %{name: name} when is_binary(name) and name != "" -> name
      _ -> "User"
    end
  end
end
