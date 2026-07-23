defmodule Manfrod.Tools.Projects do
  @moduledoc """
  Project lookup tool for the live agent — resolves project names to the
  ids/slugs used to scope note queries (see `Manfrod.Tools.Notes.list_recent_notes`).
  """

  alias Manfrod.Memory

  def definitions(_ctx) do
    [
      ReqLLM.Tool.new!(
        name: "list_projects",
        description:
          "List all known projects (name + slug). Use when you need to confirm or disambiguate a project the user named before filtering notes by it (e.g. via list_recent_notes' `project` parameter).",
        parameter_schema: [],
        callback: fn _args -> list_projects() end
      )
    ]
  end

  defp list_projects do
    case Memory.list_projects() do
      [] ->
        {:ok, "No projects configured."}

      projects ->
        lines = Enum.map(projects, fn p -> "- #{p.name} (slug: #{p.slug})" end)
        {:ok, "Projects:\n#{Enum.join(lines, "\n")}"}
    end
  end
end
