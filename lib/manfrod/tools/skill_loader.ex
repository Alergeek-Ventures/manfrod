defmodule Manfrod.Tools.SkillLoader do
  @moduledoc """
  Tool that lets the live agent pull a skill's full body into context on
  demand (second level of progressive disclosure — see `Manfrod.Skills`).
  """

  alias Manfrod.Skills

  def definitions(_ctx) do
    [
      ReqLLM.Tool.new!(
        name: "use_skill",
        description:
          "Load the full instructions for one of your Available Skills (listed in your system prompt) when it's relevant to the current message.",
        parameter_schema: [
          name: [type: :string, required: true, doc: "Skill name, e.g. 'vacation-tracking'"]
        ],
        callback: fn args -> use_skill(args) end
      )
    ]
  end

  defp use_skill(%{name: name}) do
    case Skills.get_body(name) do
      {:ok, body} -> {:ok, body}
      {:error, :not_found} -> {:ok, "Skill not found: #{name}"}
    end
  end
end
