defmodule Manfrod.Mcp do
  @moduledoc """
  User-owned connections to remote MCP servers (Linear, Granola, or any
  custom server a user adds by URL).

  `builtin_providers/0` lists the app's known providers; `providers_for_user/1`
  adds a given user's own custom providers on top. Everything else (the
  MCP page, the OAuth controller, agent tool wiring) reads from these
  instead of hardcoding provider lists — a "provider" is always the same
  shape: `%{id:, name:, mcp_url:, mock:, logo_url:, custom:, scope:}`.
  `scope` is nil unless the provider's authorize endpoint requires an
  explicit `scope` param (e.g. Firmowid rejects requests without one).
  """

  import Ecto.Query

  alias Manfrod.Mcp.Connection
  alias Manfrod.Mcp.CustomProvider
  alias Manfrod.Mcp.OauthClient
  alias Manfrod.Repo

  @doc """
  Built-in MCP providers. `:mock` providers have no real OAuth flow — the
  MCP page shows them as a "coming soon" card with nothing to click.
  """
  def builtin_providers do
    [
      %{
        id: "linear",
        name: "Linear",
        mcp_url: "https://mcp.linear.app/mcp",
        mock: false,
        logo_url: nil,
        custom: false,
        scope: nil
      },
      %{
        id: "granola",
        name: "Granola",
        mcp_url: "https://mcp.granola.ai/mcp",
        mock: false,
        logo_url: nil,
        custom: false,
        scope: nil
      },
      %{
        id: "firmowid",
        name: "Firmowid",
        mcp_url: "https://firmowid.pl/mcp",
        mock: false,
        logo_url: nil,
        custom: false,
        scope: "mcp"
      }
    ]
  end

  @doc "Built-in providers plus this user's own custom providers, unified shape."
  def providers_for_user(user_id) do
    builtin_providers() ++ custom_providers_as_providers(user_id)
  end

  @doc "Look up a provider (built-in or this user's custom one) by id."
  def get_provider_for_user(user_id, id) do
    Enum.find(builtin_providers(), &(&1.id == id)) ||
      Enum.find(custom_providers_as_providers(user_id), &(&1.id == id))
  end

  defp custom_providers_as_providers(user_id) do
    user_id
    |> list_custom_providers()
    |> Enum.map(fn cp ->
      %{
        id: cp.id,
        name: cp.name || cp.url,
        mcp_url: cp.url,
        mock: false,
        logo_url: cp.logo_url,
        custom: true,
        scope: nil
      }
    end)
  end

  # ---------------------------------------------------------------------------
  # Custom providers
  # ---------------------------------------------------------------------------

  def list_custom_providers(user_id) do
    Repo.all(
      from(c in CustomProvider, where: c.user_id == ^user_id, order_by: [asc: c.inserted_at])
    )
  end

  def get_custom_provider(user_id, id) do
    Repo.one(from(c in CustomProvider, where: c.user_id == ^user_id and c.id == ^id))
  end

  @doc """
  Adds a custom MCP provider for `user_id` by URL, then best-effort
  auto-discovers its name/logo (`Manfrod.Mcp.Discovery`) before returning.
  """
  def create_custom_provider(user_id, url, name \\ nil) do
    with {:ok, provider} <-
           %CustomProvider{}
           |> CustomProvider.changeset(%{user_id: user_id, url: url, name: presence(name)})
           |> Repo.insert() do
      discovered = Manfrod.Mcp.Discovery.fetch_info(url)

      attrs =
        %{}
        |> maybe_put(:name, presence(provider.name) || discovered.name)
        |> maybe_put(:logo_url, discovered.logo_url)

      if map_size(attrs) > 0 do
        provider |> CustomProvider.changeset(attrs) |> Repo.update()
      else
        {:ok, provider}
      end
    end
  end

  @doc "Removes a custom provider and any connection/oauth-client state under it."
  def delete_custom_provider(user_id, id) do
    case get_custom_provider(user_id, id) do
      nil ->
        {:error, :not_found}

      provider ->
        disconnect(user_id, id)
        Repo.delete_all(from(c in OauthClient, where: c.provider == ^id))
        Repo.delete(provider)
    end
  end

  defp presence(nil), do: nil
  defp presence(""), do: nil
  defp presence(str), do: str

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  # ---------------------------------------------------------------------------
  # Connections
  # ---------------------------------------------------------------------------

  @doc "List all connections for a user, keyed by provider id."
  def list_connections(user_id) do
    Repo.all(from(c in Connection, where: c.user_id == ^user_id))
    |> Map.new(&{&1.provider, &1})
  end

  def get_connection(user_id, provider) do
    Repo.one(from(c in Connection, where: c.user_id == ^user_id and c.provider == ^provider))
  end

  @doc """
  All connections for a single provider in a given status (default
  `"connected"`). Unlike `list_all_connections_with_provider/0`, this
  doesn't resolve provider info — callers who already know the provider
  (e.g. a per-user cron-skill declaring `requires_mcp: "firmowid"`) just
  need the list of user ids/tokens to fan out over.
  """
  def list_connections_for_provider(provider_id, status \\ "connected") do
    Repo.all(from(c in Connection, where: c.provider == ^provider_id and c.status == ^status))
  end

  @doc """
  Every non-disconnected connection paired with its resolved provider info
  (built-in or the owner's custom provider). Skips connections whose
  custom provider was deleted out from under them. Used by the
  expiry-check worker, which has to look across every user's connections
  regardless of which providers they each defined for themselves.
  """
  def list_all_connections_with_provider do
    Repo.all(from(c in Connection, where: c.status in ["connected", "expired"]))
    |> Enum.flat_map(fn conn ->
      case get_provider_for_user(conn.user_id, conn.provider) do
        nil -> []
        provider -> [{conn, provider}]
      end
    end)
  end

  @doc "Create or update a user's connection after a successful OAuth exchange."
  def save_tokens(user_id, provider, attrs) do
    attrs =
      attrs
      |> Map.put(:user_id, user_id)
      |> Map.put(:provider, provider)
      |> Map.put_new(:status, "connected")

    case get_connection(user_id, provider) do
      nil -> %Connection{}
      conn -> conn
    end
    |> Connection.changeset(attrs)
    |> Repo.insert_or_update()
  end

  @doc "Mark a connection expired. No-op (returns the unchanged record) if already expired."
  def mark_expired(%Connection{status: "expired"} = conn), do: {:ok, conn}

  def mark_expired(%Connection{} = conn) do
    conn
    |> Connection.changeset(%{status: "expired"})
    |> Repo.update()
  end

  def mark_notified(%Connection{} = conn) do
    conn
    |> Connection.changeset(%{
      notified_expired_at: DateTime.utc_now() |> DateTime.truncate(:second)
    })
    |> Repo.update()
  end

  def disconnect(user_id, provider) do
    case get_connection(user_id, provider) do
      nil -> {:ok, nil}
      conn -> Repo.delete(conn)
    end
  end

  @doc """
  Returns `{:ok, access_token}` for a connection, refreshing it first if it's
  expiring within the next minute. `{:error, reason}` otherwise — the caller
  (a tool call, or the expiry-check worker) decides whether to mark the
  connection expired and notify the user.
  """
  def ensure_valid_token(%Connection{status: "disconnected"}), do: {:error, :disconnected}
  def ensure_valid_token(%Connection{access_token: nil}), do: {:error, :no_token}

  def ensure_valid_token(%Connection{} = conn) do
    if token_expiring_soon?(conn) do
      refresh_token(conn)
    else
      {:ok, conn.access_token}
    end
  end

  @doc "Refreshes a connection's access token and persists the result."
  def refresh_token(%Connection{refresh_token: nil}), do: {:error, :no_refresh_token}

  def refresh_token(%Connection{} = conn) do
    case Manfrod.Mcp.OAuth.refresh(conn.provider, conn.refresh_token) do
      {:ok, tokens} ->
        expires_at =
          if tokens.expires_in do
            DateTime.utc_now()
            |> DateTime.add(tokens.expires_in, :second)
            |> DateTime.truncate(:second)
          end

        case save_tokens(conn.user_id, conn.provider, %{
               access_token: tokens.access_token,
               refresh_token: tokens.refresh_token || conn.refresh_token,
               expires_at: expires_at,
               status: "connected",
               notified_expired_at: nil
             }) do
          {:ok, updated} -> {:ok, updated.access_token}
          {:error, reason} -> {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp token_expiring_soon?(%Connection{expires_at: nil}), do: false

  defp token_expiring_soon?(%Connection{expires_at: expires_at}) do
    DateTime.diff(expires_at, DateTime.utc_now()) < 60
  end

  # ---------------------------------------------------------------------------
  # OAuth client registration cache
  # ---------------------------------------------------------------------------

  def get_oauth_client(provider) do
    Repo.one(from(c in OauthClient, where: c.provider == ^provider))
  end

  def save_oauth_client(provider, attrs) do
    attrs = Map.put(attrs, :provider, provider)

    case get_oauth_client(provider) do
      nil -> %OauthClient{}
      client -> client
    end
    |> OauthClient.changeset(attrs)
    |> Repo.insert_or_update()
  end
end
