defmodule Manfrod.Skills do
  @moduledoc """
  Discovers and loads Agent Skills — markdown instructions the live agent can
  pull into context on demand, following Anthropic's progressive-disclosure
  design: a skill's `name`/`description` frontmatter is always visible (see
  `catalog_text/0`), while the full body is only loaded when the agent decides
  it's relevant (see `get_body/1`, wired to the `use_skill` tool).

  Skills live under `priv/skills/<skill-name>/SKILL.md` (priv/ so they ship
  inside a compiled release — see Dockerfile/`mix release`, unlike lib/ which
  is source-only) and are read from disk on every call (not embedded at
  compile time), so hand-edited skills take effect on the next new agent
  session without a recompile.

  Not every file under `skills/` is a discoverable skill — `read_prompt/1`
  reads a plain prompt file (no frontmatter, no relevance decision) for
  callers like `Manfrod.Memory.Classifier` that always use their prompt in
  full.
  """

  @doc """
  List all discoverable skills (folders containing a `SKILL.md`) as
  `%{name: name, description: description}` maps.
  """
  def list do
    skills_dir()
    |> File.ls()
    |> case do
      {:ok, entries} -> entries
      {:error, _} -> []
    end
    |> Enum.flat_map(&load_skill/1)
  end

  @doc """
  Formats the always-on skill catalog for injection into the agent's system
  prompt: every skill's name and description, nothing else.
  """
  def catalog_text do
    case list() do
      [] ->
        nil

      skills ->
        items =
          skills
          |> Enum.map(fn %{name: name, description: description} ->
            "- #{name}: #{description}"
          end)
          |> Enum.join("\n")

        """
        [Available Skills — call use_skill(name) to load full instructions when relevant]
        #{items}
        """
    end
  end

  @doc """
  Fetch a skill's full body (everything after the frontmatter) by name.
  """
  def get_body(name) do
    path = skill_path(name)

    case File.read(path) do
      {:ok, content} ->
        case parse(content) do
          {:ok, _frontmatter, body} -> {:ok, body}
          :error -> {:error, :not_found}
        end

      {:error, _} ->
        {:error, :not_found}
    end
  end

  @doc """
  Read a plain prompt file (relative to the skills directory) with no
  frontmatter parsing. Used for prompts that are always loaded in full,
  like the memory classifier's.
  """
  def read_prompt(relative_path) do
    skills_dir()
    |> Path.join(relative_path)
    |> File.read!()
  end

  # Private

  # Resolved at runtime, not compile time: this must NOT be a module
  # attribute. Application.app_dir/2 depends on the current code path — under
  # a compiled release, that differs between the Docker build stage (where a
  # module attribute would bake in a _build/... path) and the actual running
  # release, so it has to be called fresh on every use.
  defp skills_dir, do: Application.app_dir(:manfrod, "priv/skills")

  defp load_skill(entry) do
    path = skill_path(entry)

    with true <- File.regular?(path),
         {:ok, content} <- File.read(path),
         {:ok, frontmatter, _body} <- parse(content) do
      [%{name: frontmatter["name"] || entry, description: frontmatter["description"] || ""}]
    else
      _ -> []
    end
  end

  defp skill_path(name), do: Path.join([skills_dir(), name, "SKILL.md"])

  defp parse(content) do
    case String.split(content, "---", parts: 3) do
      ["", frontmatter_raw, body] ->
        {:ok, parse_frontmatter(frontmatter_raw), String.trim(body)}

      _ ->
        :error
    end
  end

  defp parse_frontmatter(raw) do
    raw
    |> String.split("\n")
    |> Enum.reduce(%{}, fn line, acc ->
      case String.split(line, ":", parts: 2) do
        [key, value] -> Map.put(acc, String.trim(key), String.trim(value))
        _ -> acc
      end
    end)
  end
end
