defmodule Manfrod.Tools.Facts do
  @moduledoc """
  Structured fact lookup tools (vacations, absences, meetings) for the live agent.
  """

  def definitions(readable_levels) do
    [
      ReqLLM.Tool.new!(
        name: "get_fact",
        description:
          "Look up a structured fact by key (vacations, meetings, absences). Key format: 'vacation:user_id', 'absence:name:date', 'meeting:channel:ts'.",
        parameter_schema: [
          key: [type: :string, required: true, doc: "Exact fact key"]
        ],
        callback: fn args -> get_fact(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_facts",
        description:
          "List structured facts with a key prefix. E.g. prefix 'vacation:' lists all vacations you can see.",
        parameter_schema: [
          prefix: [type: :string, required: true, doc: "Key prefix to search"]
        ],
        callback: fn args -> list_facts(readable_levels, args) end
      )
    ]
  end

  defp get_fact(readable_levels, %{key: key}) do
    case Manfrod.Facts.get_fact(key, readable_levels) do
      nil -> {:ok, "Fact not found: #{key}"}
      fact -> {:ok, "#{fact.key}: #{fact.value}"}
    end
  end

  defp list_facts(readable_levels, %{prefix: prefix}) do
    facts = Manfrod.Facts.list_facts(prefix, readable_levels)

    if Enum.empty?(facts) do
      {:ok, "No facts found with prefix: #{prefix}"}
    else
      lines = Enum.map(facts, fn f -> "- #{f.key}: #{f.value}" end)
      {:ok, Enum.join(lines, "\n")}
    end
  end
end
