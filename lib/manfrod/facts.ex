defmodule Manfrod.Facts do
  @moduledoc """
  Deterministic structured facts store.

  Facts are key-value pairs with access arrays and optional validity windows.
  Unlike Memory nodes they are queried by key, not by semantic search.

  Examples:
    set_fact("absence:user-id", "2026-07-14..2026-07-21", ["internal", "external/all"], user_id)
    list_facts("absence:", ["internal", "external/all"])
  """

  import Ecto.Query

  alias Manfrod.Repo
  alias Manfrod.Memory.{Access, Fact}

  @doc """
  Write a fact. If a fact with the same key already exists, updates it.
  """
  @spec set_fact(
          key :: String.t(),
          value :: String.t(),
          access :: [String.t()],
          user_id :: binary()
        ) ::
          {:ok, Fact.t()} | {:error, Ecto.Changeset.t()}
  def set_fact(key, value, access, user_id) do
    case Repo.one(from f in Fact, where: f.key == ^key) do
      nil ->
        %Fact{}
        |> Fact.changeset(%{key: key, value: value, access: access, set_by_user_id: user_id})
        |> Repo.insert()

      existing ->
        existing
        |> Fact.changeset(%{value: value, access: access})
        |> Repo.update()
    end
  end

  @doc """
  Widen an existing fact's access by adding a level (confirmed escalation).
  """
  @spec add_access(key :: String.t(), level :: String.t()) ::
          {:ok, Fact.t()} | {:error, :not_found | Ecto.Changeset.t()}
  def add_access(key, level) do
    case Repo.one(from f in Fact, where: f.key == ^key) do
      nil ->
        {:error, :not_found}

      fact ->
        fact
        |> Fact.changeset(%{access: Enum.uniq(fact.access ++ [level])})
        |> Repo.update()
    end
  end

  @doc """
  Get a single fact by key, filtered by readable access levels.
  Returns nil if not found or not accessible.
  """
  @spec get_fact(key :: String.t(), readable_levels :: [String.t()]) :: Fact.t() | nil
  def get_fact(key, readable_levels) do
    Repo.one(
      from f in Fact,
        where: f.key == ^key,
        where: ^Access.dynamic_where(readable_levels)
    )
  end

  @doc """
  List facts whose key starts with the given prefix, filtered by readable access levels.
  """
  @spec list_facts(key_prefix :: String.t(), readable_levels :: [String.t()]) :: [Fact.t()]
  def list_facts(key_prefix, readable_levels) do
    Repo.all(
      from f in Fact,
        where: like(f.key, ^"#{key_prefix}%"),
        where: ^Access.dynamic_where(readable_levels),
        order_by: [asc: f.key]
    )
  end

  @doc """
  List facts whose key starts with the given prefix AND were set by a
  specific user, filtered by readable access levels. Useful when the key
  falls back to a display name instead of the user id (e.g.
  `absence:<user_name>:<date>`, for messages from unmapped Slack users) —
  `set_by_user_id` is the reliable join in that case.
  """
  @spec list_facts_by_user(
          key_prefix :: String.t(),
          user_id :: binary(),
          readable_levels :: [String.t()]
        ) :: [Fact.t()]
  def list_facts_by_user(key_prefix, user_id, readable_levels) do
    Repo.all(
      from f in Fact,
        where: like(f.key, ^"#{key_prefix}%"),
        where: f.set_by_user_id == ^user_id,
        where: ^Access.dynamic_where(readable_levels),
        order_by: [asc: f.key]
    )
  end

  @doc """
  List facts whose key starts with the given prefix AND were set by a
  specific user, ignoring access entirely. For system-level checks (e.g.
  the classifier deduplicating a fact against what's already recorded)
  where the caller isn't a reader whose visibility should be scoped —
  never expose this through a tool the LLM can call directly.
  """
  @spec list_facts_by_user_unscoped(key_prefix :: String.t(), user_id :: binary()) :: [Fact.t()]
  def list_facts_by_user_unscoped(key_prefix, user_id) do
    Repo.all(
      from f in Fact,
        where: like(f.key, ^"#{key_prefix}%"),
        where: f.set_by_user_id == ^user_id,
        order_by: [asc: f.key]
    )
  end

  @doc """
  Record an absence for `user_id`, replacing any of their absences whose
  dates overlap it: a restated or corrected absence supersedes the old
  record instead of sitting next to it. A replaced record keeps its access,
  so a correction of an absence already shared with clients is shared too.

  Returns `{:ok, fact, :created | :replaced}` or `{:error, changeset}`.
  """
  @spec put_absence(binary(), String.t(), String.t(), String.t(), [String.t()]) ::
          {:ok, Fact.t(), :created | :replaced} | {:error, Ecto.Changeset.t()}
  def put_absence(user_id, start_date, end_date, description, access) do
    key = "absence:#{user_id}:#{start_date}"
    value = "#{start_date}..#{end_date} — #{description}"

    Repo.transaction(fn ->
      case overlapping_absences(user_id, start_date, end_date) do
        [] ->
          case set_fact(key, value, access, user_id) do
            {:ok, fact} -> {fact, :created}
            {:error, changeset} -> Repo.rollback(changeset)
          end

        [kept | others] ->
          Enum.each(others, &Repo.delete!/1)
          Repo.delete_all(from f in Fact, where: f.key == ^key and f.id != ^kept.id)

          case kept |> Fact.changeset(%{key: key, value: value}) |> Repo.update() do
            {:ok, fact} -> {fact, :replaced}
            {:error, changeset} -> Repo.rollback(changeset)
          end
      end
    end)
    |> case do
      {:ok, {fact, outcome}} -> {:ok, fact, outcome}
      {:error, changeset} -> {:error, changeset}
    end
  end

  @doc """
  The user's absences whose date range overlaps `start_date..end_date`
  (ISO dates), regardless of access.
  """
  @spec overlapping_absences(binary(), String.t(), String.t()) :: [Fact.t()]
  def overlapping_absences(user_id, start_date, end_date) do
    with {:ok, new_from} <- Date.from_iso8601(start_date),
         {:ok, new_to} <- Date.from_iso8601(end_date) do
      "absence:"
      |> list_facts_by_user_unscoped(user_id)
      |> Enum.filter(fn fact ->
        case parse_date_range(fact.value) do
          {:ok, from, to} ->
            Date.compare(new_from, to) != :gt and Date.compare(new_to, from) != :lt

          :error ->
            false
        end
      end)
    else
      _ -> []
    end
  end

  @doc """
  Delete absences that ended before `date`. They are only noise once over:
  the leave digest, holiday checks and the agent all care about upcoming or
  current absences, and Firmowid keeps the real leave history.

  Returns the number of facts deleted.
  """
  @spec delete_absences_ended_before(Date.t()) :: non_neg_integer()
  def delete_absences_ended_before(date) do
    ids =
      from(f in Fact, where: like(f.key, "absence:%"))
      |> Repo.all()
      |> Enum.filter(fn fact ->
        case parse_date_range(fact.value) do
          {:ok, _from, to} -> Date.compare(to, date) == :lt
          :error -> false
        end
      end)
      |> Enum.map(& &1.id)

    {count, _} = Repo.delete_all(from f in Fact, where: f.id in ^ids)
    count
  end

  @doc """
  Parse a fact value of the form "YYYY-MM-DD..YYYY-MM-DD — ..." into its
  {from, to} date range. Returns :error if the value doesn't start with a
  recognizable date range.
  """
  @spec parse_date_range(value :: String.t()) :: {:ok, Date.t(), Date.t()} | :error
  def parse_date_range(value) do
    case Regex.run(~r/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/, value) do
      [_, from_s, to_s] ->
        with {:ok, from} <- Date.from_iso8601(from_s),
             {:ok, to} <- Date.from_iso8601(to_s) do
          {:ok, from, to}
        else
          _ -> :error
        end

      _ ->
        :error
    end
  end
end
