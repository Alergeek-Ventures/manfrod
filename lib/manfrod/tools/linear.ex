defmodule Manfrod.Tools.Linear do
  @moduledoc """
  Exposes the current channel's project's connected Linear team as
  read-only agent tools.

  Connections are per-project (`Manfrod.Linear`), gated by the channel's
  active project mapping (`Manfrod.Memory.Access.get_active_mapping/1`). If
  the channel isn't mapped to a project, or the project has no connected
  Linear key, no tools are returned — mirrors `Manfrod.Tools.Mcp`.
  """

  alias Manfrod.Linear
  alias Manfrod.Linear.Client
  alias Manfrod.Memory.Access

  def definitions(%{msg_ctx: %{channel: channel}}) when is_binary(channel) do
    with %{project_id: project_id} <- Access.get_active_mapping(channel),
         %{status: "connected"} = conn <- Linear.get_connection(project_id) do
      build_tools(conn)
    else
      _ -> []
    end
  end

  def definitions(_ctx), do: []

  defp build_tools(conn) do
    [
      ReqLLM.Tool.new!(
        name: "linear_list_issues",
        description: "Lists recent issues for this project's connected Linear team.",
        parameter_schema: [
          limit: [type: :integer, required: false, doc: "Max issues to return (default 25)"]
        ],
        callback: fn args -> list_issues(conn, args) end
      ),
      ReqLLM.Tool.new!(
        name: "linear_get_issue",
        description: "Gets a single Linear issue by its identifier (e.g. \"ENG-123\").",
        parameter_schema: [
          identifier: [type: :string, required: true, doc: "Issue identifier, e.g. ENG-123"]
        ],
        callback: fn args -> get_issue(conn, args) end
      ),
      ReqLLM.Tool.new!(
        name: "linear_search_issues",
        description: "Full-text searches this project's connected Linear team's issues.",
        parameter_schema: [
          term: [type: :string, required: true, doc: "Search term"],
          limit: [type: :integer, required: false, doc: "Max results to return (default 25)"]
        ],
        callback: fn args -> search_issues(conn, args) end
      ),
      ReqLLM.Tool.new!(
        name: "linear_list_projects",
        description: "Lists Linear projects owned by this project's connected team.",
        parameter_schema: [],
        callback: fn _args -> list_projects(conn) end
      ),
      ReqLLM.Tool.new!(
        name: "linear_list_cycles",
        description: "Lists recent cycles for this project's connected Linear team.",
        parameter_schema: [
          limit: [type: :integer, required: false, doc: "Max cycles to return (default 10)"]
        ],
        callback: fn args -> list_cycles(conn, args) end
      )
    ]
  end

  defp list_issues(conn, args) do
    opts = [limit: Map.get(args, :limit, 25)]

    case Client.list_issues(conn.api_key, conn.linear_team_id, opts) do
      {:ok, issues} -> {:ok, format_issues(issues)}
      {:error, reason} -> {:ok, "Nie udało się pobrać issues z Linear: #{inspect(reason)}"}
    end
  end

  defp get_issue(conn, %{identifier: identifier}) do
    case Client.get_issue(conn.api_key, conn.linear_team_id, identifier) do
      {:ok, nil} -> {:ok, "Nie znaleziono issue #{identifier}."}
      {:ok, issue} -> {:ok, format_issue_detail(issue)}
      {:error, reason} -> {:ok, "Nie udało się pobrać issue z Linear: #{inspect(reason)}"}
    end
  end

  defp search_issues(conn, args) do
    %{term: term} = args
    opts = [limit: Map.get(args, :limit, 25)]

    case Client.search_issues(conn.api_key, conn.linear_team_id, term, opts) do
      {:ok, issues} -> {:ok, format_issues(issues)}
      {:error, reason} -> {:ok, "Nie udało się wyszukać w Linear: #{inspect(reason)}"}
    end
  end

  defp list_projects(conn) do
    case Client.list_projects(conn.api_key, conn.linear_team_id) do
      {:ok, projects} -> {:ok, format_projects(projects)}
      {:error, reason} -> {:ok, "Nie udało się pobrać projektów z Linear: #{inspect(reason)}"}
    end
  end

  defp list_cycles(conn, args) do
    opts = [limit: Map.get(args, :limit, 10)]

    case Client.list_cycles(conn.api_key, conn.linear_team_id, opts) do
      {:ok, cycles} -> {:ok, format_cycles(cycles)}
      {:error, reason} -> {:ok, "Nie udało się pobrać cykli z Linear: #{inspect(reason)}"}
    end
  end

  defp format_issues([]), do: "Brak issues."

  defp format_issues(issues) do
    Enum.map_join(issues, "\n", fn issue ->
      state = get_in(issue, ["state", "name"]) || "?"
      assignee = get_in(issue, ["assignee", "name"]) || "unassigned"

      "#{issue["identifier"]} [#{state}] #{issue["title"]} (#{assignee}) — #{issue["url"]}"
    end)
  end

  defp format_issue_detail(issue) do
    state = get_in(issue, ["state", "name"]) || "?"
    assignee = get_in(issue, ["assignee", "name"]) || "unassigned"
    description = issue["description"] || "(no description)"

    "#{issue["identifier"]} [#{state}] #{issue["title"]} (#{assignee})\n" <>
      "#{description}\n#{issue["url"]}"
  end

  defp format_projects([]), do: "Brak projektów."

  defp format_projects(projects) do
    Enum.map_join(projects, "\n", fn p ->
      "#{p["name"]} [#{p["state"]}] — #{p["url"]}"
    end)
  end

  defp format_cycles([]), do: "Brak cykli."

  defp format_cycles(cycles) do
    Enum.map_join(cycles, "\n", fn c ->
      "Cycle #{c["number"]} #{c["name"] || ""} (#{c["startsAt"]} → #{c["endsAt"]})"
    end)
  end
end
