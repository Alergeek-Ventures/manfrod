defmodule Manfrod.Tools.Vacation do
  @moduledoc """
  Vacation/absence reporting tool for the live agent. Usage instructions live
  in the `vacation-tracking` skill (priv/skills/vacation-tracking/SKILL.md);
  this module only implements the tool itself.
  """

  alias Manfrod.Memory
  alias Manfrod.Memory.PendingOps
  alias Manfrod.Tools.Support
  alias Manfrod.Voyage

  def definitions(user_id, msg_ctx) do
    [
      ReqLLM.Tool.new!(
        name: "report_vacation",
        description:
          "Flag a planned absence/vacation for the background memory to record. " <>
            "The memory saves it and decides on its own whether to propose sharing with all clients. " <>
            "Call whenever the user mentions being absent — do NOT ask the user about client visibility.",
        parameter_schema: [
          start_date: [type: :string, required: true, doc: "Start date ISO8601 (YYYY-MM-DD)"],
          end_date: [type: :string, required: true, doc: "End date ISO8601 (YYYY-MM-DD)"],
          note: [type: :string, doc: "Optional note (e.g. 'on vacation', 'public holiday')"]
        ],
        callback: fn args -> report_vacation(user_id, msg_ctx, args) end
      )
    ]
  end

  # Flags the message as an absence for the memory batch. The Classifier writes
  # a named node + fact at the channel's default access and, if warranted, posts
  # the standard escalation buttons — the agent does NOT ask about external/all.
  defp report_vacation(
         user_id,
         msg_ctx,
         %{start_date: start_date, end_date: end_date} = args
       ) do
    case Support.flaggable(msg_ctx) do
      {:ok, channel_id, ts} ->
        PendingOps.flag_message(channel_id, ts, "create_absence", %{
          start_date: start_date,
          end_date: end_date,
          note: Map.get(args, :note)
        })

        {:ok,
         "Zanotowane (#{start_date}..#{end_date}). Pamięć w tle zapisze nieobecność i w razie potrzeby zapyta o udostępnienie klientom."}

      :error ->
        report_vacation_direct(user_id, args)
    end
  end

  defp report_vacation_direct(user_id, %{start_date: start_date, end_date: end_date} = args) do
    note = Map.get(args, :note, "urlop")
    key = "vacation:#{user_id}:#{start_date}"
    value = "#{start_date}..#{end_date} — #{note}"
    access = ["internal", "external/all"]
    content = "#{note}: #{start_date}..#{end_date}"

    with {:ok, _fact} <- Manfrod.Facts.set_fact(key, value, access, user_id),
         {:ok, embedding} <- Voyage.embed_query(content),
         {:ok, _node} <-
           Memory.create_node(user_id, access, %{content: content, embedding: embedding}) do
      {:ok, "Zapisałem urlop: #{value}"}
    else
      {:error, %Ecto.Changeset{} = changeset} ->
        {:ok, "Błąd zapisu: #{inspect(changeset.errors)}"}

      {:error, e} ->
        {:ok, "Błąd zapisu: #{inspect(e)}"}
    end
  end
end
