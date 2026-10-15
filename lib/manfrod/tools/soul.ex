defmodule Manfrod.Tools.Soul do
  @moduledoc """
  Reading and changing the soul of the person the agent is talking to — the
  note that opens every conversation with them (see `Manfrod.Memory.get_soul/1`).

  Changing it is only ever done on that person's explicit request; the
  retrospection agent is not allowed to touch it at all.
  """

  alias Manfrod.Memory
  alias Manfrod.Memory.Access
  alias Manfrod.Voyage

  def definitions(%{user_id: user_id} = ctx) when is_binary(user_id) do
    readable_levels = Map.get(ctx, :readable_levels) || []

    [
      ReqLLM.Tool.new!(
        name: "get_soul",
        description:
          "Show your soul for the person you are talking to: the core note that opens every conversation with them (who they are, how to work with them, who you are for them). Use when they ask what is in it, and before changing it.",
        parameter_schema: [],
        callback: fn _args -> get_soul(user_id) end
      ),
      ReqLLM.Tool.new!(
        name: "update_soul",
        description:
          "Rewrite your soul for the person you are talking to. Only when they explicitly ask you to change it (e.g. 'zapisz w swojej duszy...', 'zmień swoją osobowość na...'). Pass the complete new text: read it with get_soul first and keep everything that still holds.",
        parameter_schema: [
          content: [type: :string, required: true, doc: "The complete new soul text"]
        ],
        callback: fn args -> update_soul(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "set_soul_note",
        description:
          "Make an existing note your soul for the person you are talking to, replacing the current one (which stays as an ordinary note). Only on their explicit request.",
        parameter_schema: [
          note_id: [type: :string, required: true, doc: "UUID of the note to make the soul"]
        ],
        callback: fn args -> set_soul_note(user_id, readable_levels, args) end
      )
    ]
  end

  def definitions(_ctx), do: []

  defp get_soul(user_id) do
    case Memory.get_soul(user_id) do
      nil -> {:ok, "There is no soul yet. update_soul creates one."}
      soul -> {:ok, "Soul [#{soul.id}]:\n#{soul.content}"}
    end
  end

  defp update_soul(user_id, %{content: content}) do
    content = String.trim(content)

    with false <- content == "",
         {:ok, embedding} <- Voyage.embed_query(content),
         {:ok, soul} <-
           Memory.update_soul(user_id, content, embedding, [Access.private_level(user_id)]) do
      {:ok,
       "Soul updated [#{soul.id}]. It opens every new conversation from now on; act on it in this one already."}
    else
      true ->
        {:ok, "The soul can't be empty."}

      {:error, %Ecto.Changeset{} = changeset} ->
        {:ok, "Failed to save the soul: #{inspect(changeset.errors)}"}

      {:error, reason} ->
        {:ok, "Failed to save the soul: #{inspect(reason)}"}
    end
  end

  # Only a note this person may read: the soul ends up in their prompts.
  defp set_soul_note(user_id, readable_levels, %{note_id: note_id}) do
    with {:ok, id} <- Ecto.UUID.cast(note_id),
         %{} <- Memory.get_node_accessible(readable_levels, id),
         {:ok, soul} <- Memory.set_soul(user_id, id) do
      {:ok, "Note [#{soul.id}] is now the soul:\n#{soul.content}"}
    else
      _ -> {:ok, "Note not found: #{note_id}"}
    end
  end
end
