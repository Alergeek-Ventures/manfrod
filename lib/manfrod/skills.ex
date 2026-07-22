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

  A skill's frontmatter may also declare a `cron` field (a standard 5-field
  cron expression) alongside `name`/`description`. That's the signal that the
  skill isn't just reactive material for `use_skill` — it's a recurring job:
  `Manfrod.Workers.SkillSchedulerWorker` picks it up (see `list_cron_skills/0`)
  and `Manfrod.SkillRunner` runs it proactively on schedule — the skill's
  body becomes the instructions for a full autonomous agent turn (same
  tools as the live agent), exactly as if a user had typed them. A cron
  skill also needs a `channel` field (Slack channel ID) — that's where the
  agent's tool calls and final reply land, since there's no live message to
  reply to.
  """

  @doc """
  List all discoverable skills (folders containing a `SKILL.md`) as
  `%{name: name, description: description, cron: cron_or_nil}` maps.
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
  List skills that declare a `cron` field — the ones
  `Manfrod.Workers.SkillSchedulerWorker` runs proactively on schedule instead
  of only loading reactively via `use_skill`.
  """
  def list_cron_skills do
    list() |> Enum.filter(&(&1.cron not in [nil, ""]))
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
  Fetch a skill's full metadata (name/description/cron/channel) plus body in
  one call — what `Manfrod.SkillRunner` needs to run a cron-skill.
  """
  def get(name) do
    path = skill_path(name)

    with {:ok, content} <- File.read(path),
         {:ok, frontmatter, body} <- parse(content) do
      {:ok,
       %{
         name: frontmatter["name"] || name,
         description: frontmatter["description"] || "",
         cron: frontmatter["cron"],
         channel: frontmatter["channel"],
         body: body
       }}
    else
      _ -> {:error, :not_found}
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
  # Overridable via the :skills_dir app env, test-only (points at a fixture
  # directory instead of priv/skills so frontmatter-parsing tests don't have
  # to add fake entries to the real, agent-visible skill catalog).
  defp skills_dir do
    Application.get_env(:manfrod, :skills_dir) || Application.app_dir(:manfrod, "priv/skills")
  end

  defp load_skill(entry) do
    path = skill_path(entry)

    with true <- File.regular?(path),
         {:ok, content} <- File.read(path),
         {:ok, frontmatter, _body} <- parse(content) do
      [
        %{
          name: frontmatter["name"] || entry,
          description: frontmatter["description"] || "",
          cron: frontmatter["cron"],
          channel: frontmatter["channel"]
        }
      ]
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
        [key, value] -> Map.put(acc, String.trim(key), unquote_value(String.trim(value)))
        _ -> acc
      end
    end)
  end

  # YAML-style frontmatter values are often quoted (e.g. `cron: "0 0 * * 0"`)
  # to protect characters like `*`; this parser is otherwise quote-agnostic,
  # so strip a single matching pair of quotes if present.
  defp unquote_value(value) do
    case Regex.run(~r/^(["'])(.*)\1$/, value) do
      [_, _, inner] -> inner
      nil -> value
    end
  end
end
