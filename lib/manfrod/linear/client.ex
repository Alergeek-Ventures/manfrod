defmodule Manfrod.Linear.Client do
  @moduledoc """
  Thin GraphQL client for Linear's API (https://developers.linear.app/docs/graphql/working-with-the-graphql-api).

  Personal API Keys authenticate via a raw `Authorization` header — no
  `Bearer` prefix.

  Requests go through `Req`, with an injectable `:plug` (set via
  `Application.get_env(:manfrod, :linear_req_plug)`) so tests can stub
  responses with `Req.Test` instead of hitting the real API.
  """

  require Logger

  @endpoint "https://api.linear.app/graphql"

  @doc """
  Runs a GraphQL query/mutation against Linear's API with the given
  Personal API Key.

  Returns `{:ok, data}`, `{:error, :unauthorized}` (bad/revoked key), or
  `{:error, reason}`.
  """
  @spec query(String.t(), String.t(), map()) :: {:ok, map()} | {:error, term()}
  def query(api_key, query, variables \\ %{}) do
    req =
      Req.new(
        base_url: @endpoint,
        headers: [{"authorization", api_key}],
        plug: Application.get_env(:manfrod, :linear_req_plug)
      )

    case Req.post(req, json: %{query: query, variables: variables}) do
      {:ok, %Req.Response{status: 200, body: %{"errors" => [%{"message" => message} | _]}}} ->
        Logger.warning("Linear.Client: GraphQL error: #{message}")
        {:error, {:graphql_error, message}}

      {:ok, %Req.Response{status: 200, body: %{"data" => data}}} ->
        {:ok, data}

      {:ok, %Req.Response{status: status}} when status in [401, 403] ->
        {:error, :unauthorized}

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.warning("Linear.Client: unexpected HTTP #{status}: #{inspect(body)}")
        {:error, {:unexpected_status, status}}

      {:error, reason} ->
        Logger.warning("Linear.Client: transport error: #{inspect(reason)}")
        {:error, reason}
    end
  end

  @doc "Verifies a key and returns the single team it's scoped to, `{:ok, %{id:, name:}}`."
  def verify_key(api_key) do
    query = """
    query {
      organization {
        teams {
          nodes { id name }
        }
      }
    }
    """

    with {:ok, %{"organization" => %{"teams" => %{"nodes" => nodes}}}} <- query(api_key, query) do
      case nodes do
        [%{"id" => id, "name" => name} | _] -> {:ok, %{id: id, name: name}}
        [] -> {:error, :no_team_scoped}
      end
    end
  end

  @doc "Issues for the given team, most-recently-updated first."
  def list_issues(api_key, team_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 25)

    query = """
    query($teamId: ID!, $limit: Int!) {
      issues(filter: { team: { id: { eq: $teamId } } }, first: $limit, orderBy: updatedAt) {
        nodes {
          identifier
          title
          state { name }
          assignee { name }
          url
        }
      }
    }
    """

    with {:ok, %{"issues" => %{"nodes" => nodes}}} <-
           query(api_key, query, %{teamId: team_id, limit: limit}) do
      {:ok, nodes}
    end
  end

  @doc "A single issue by its identifier (e.g. `\"ENG-123\"`), scoped to the team."
  def get_issue(api_key, team_id, identifier) do
    query = """
    query($teamId: ID!, $identifier: Int!) {
      issues(filter: { team: { id: { eq: $teamId } }, number: { eq: $identifier } }, first: 1) {
        nodes {
          identifier
          title
          description
          state { name }
          assignee { name }
          url
        }
      }
    }
    """

    number =
      identifier
      |> String.split("-")
      |> List.last()
      |> then(&(Integer.parse(&1) |> elem(0)))

    with {:ok, %{"issues" => %{"nodes" => nodes}}} <-
           query(api_key, query, %{teamId: team_id, identifier: number}) do
      case nodes do
        [issue] -> {:ok, issue}
        [] -> {:ok, nil}
      end
    end
  end

  @doc "Full-text search over the team's issues."
  def search_issues(api_key, team_id, term, opts \\ []) do
    limit = Keyword.get(opts, :limit, 25)

    query = """
    query($teamId: ID!, $term: String!, $limit: Int!) {
      issueSearch(filter: { team: { id: { eq: $teamId } } }, term: $term, first: $limit) {
        nodes {
          identifier
          title
          state { name }
          assignee { name }
          url
        }
      }
    }
    """

    with {:ok, %{"issueSearch" => %{"nodes" => nodes}}} <-
           query(api_key, query, %{teamId: team_id, term: term, limit: limit}) do
      {:ok, nodes}
    end
  end

  @doc "Projects owned by the team."
  def list_projects(api_key, team_id) do
    query = """
    query($teamId: ID!) {
      team(id: $teamId) {
        projects {
          nodes { id name state url }
        }
      }
    }
    """

    with {:ok, %{"team" => %{"projects" => %{"nodes" => nodes}}}} <-
           query(api_key, query, %{teamId: team_id}) do
      {:ok, nodes}
    end
  end

  @doc "Cycles for the team, most recent first."
  def list_cycles(api_key, team_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 10)

    query = """
    query($teamId: ID!, $limit: Int!) {
      team(id: $teamId) {
        cycles(first: $limit, orderBy: updatedAt) {
          nodes { number name startsAt endsAt }
        }
      }
    }
    """

    with {:ok, %{"team" => %{"cycles" => %{"nodes" => nodes}}}} <-
           query(api_key, query, %{teamId: team_id, limit: limit}) do
      {:ok, nodes}
    end
  end
end
