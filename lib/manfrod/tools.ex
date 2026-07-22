defmodule Manfrod.Tools do
  @moduledoc """
  Discovers every tool module under `Manfrod.Tools.*` and merges their tool
  definitions into one list — the same zero-config way `Manfrod.Skills`
  discovers markdown skills. Drop a new module in `lib/manfrod/tools/`
  exposing `definitions/1`, and it's picked up automatically: nothing to
  alias, concatenate, or list by hand in `Manfrod.Agent.Server`.

  Every tool module must export `definitions(ctx)`, where `ctx` is the map
  built once per turn by `Manfrod.Agent.Server` (`:user_id`,
  `:readable_levels`, `:write_access`, `:msg_ctx`) and passed through
  unchanged — a module reads only the keys it actually needs.
  """

  @doc "All tool definitions for the current turn, from every discovered tool module."
  def definitions(ctx) do
    Enum.flat_map(modules(), & &1.definitions(ctx))
  end

  @doc """
  Formats every discovered tool's name and description for the system
  prompt's capabilities section — nothing to keep in sync by hand. Tool
  descriptions never depend on `ctx` (only their callbacks do), so this is
  safe to call once at prompt-build time with a placeholder ctx.
  """
  def capabilities_text(ctx) do
    ctx
    |> definitions()
    |> Enum.map_join("\n", &"- #{&1.name}: #{&1.description}")
  end

  # Every compiled module three-or-more segments under the Manfrod.Tools
  # namespace (excluding this module) that exports definitions/1. Shared
  # helpers like Manfrod.Tools.Support are excluded by the arity check, not
  # by name, so no separate ignore-list is needed.
  defp modules do
    {:ok, modules} = :application.get_key(:manfrod, :modules)

    modules
    |> Enum.filter(&tool_module?/1)
    |> Enum.sort()
  end

  defp tool_module?(module) do
    case Module.split(module) do
      ["Manfrod", "Tools", _ | _] ->
        Code.ensure_loaded?(module) and function_exported?(module, :definitions, 1)

      _ ->
        false
    end
  end
end
