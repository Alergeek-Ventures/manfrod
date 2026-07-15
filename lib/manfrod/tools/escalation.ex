defmodule Manfrod.Tools.Escalation do
  @moduledoc """
  Note visibility escalation tool for the live agent.
  """

  alias Manfrod.Memory.PendingOps
  alias Manfrod.Tools.Support

  def definitions(readable_levels, msg_ctx) do
    [
      ReqLLM.Tool.new!(
        name: "escalate_note",
        description:
          "Flag an existing note to have its visibility widened (e.g. internal → external/client); applied by the background memory. Use when the user explicitly asks to share it more widely.",
        parameter_schema: [
          node_id: [type: :string, required: true, doc: "Note UUID"],
          new_access_level: [
            type: :string,
            required: true,
            doc: "New access level to add, e.g. 'external/10bps' or 'external/all'"
          ]
        ],
        callback: fn args -> escalate_note(readable_levels, msg_ctx, args) end
      )
    ]
  end

  defp escalate_note(readable_levels, msg_ctx, %{node_id: node_id, new_access_level: level}) do
    case Support.flaggable(msg_ctx) do
      {:ok, channel_id, ts} ->
        PendingOps.add_op(
          channel_id,
          ts,
          {:escalate, %{node_id: node_id, level: level, readable_levels: readable_levels}}
        )

        {:ok, "Zaznaczyłem do poszerzenia widoczności: #{node_id} → #{level}"}

      :error ->
        escalate_note_direct(readable_levels, node_id, level)
    end
  end

  defp escalate_note_direct(readable_levels, node_id, level) do
    case Manfrod.Memory.escalate_note_access(node_id, level, readable_levels) do
      {:ok, _} -> {:ok, "Nota #{node_id} teraz widoczna jako: #{level}"}
      {:error, :not_found} -> {:ok, "Nota nie znaleziona: #{node_id}"}
      {:error, e} -> {:ok, "Błąd: #{inspect(e)}"}
    end
  end
end
