defmodule ManfrodWeb.IntegrationsLive do
  @moduledoc """
  Top-level "integrations" page — lets any authenticated user (anyone
  who's ever messaged the bot on Slack, since that's the login
  prerequisite) connect their own accounts: MCP servers (Granola, Firmowid,
  any custom server by URL) and other app logins like Kalafiornia.
  Connections are per-person; the agent picks them up automatically in DMs
  and channel threads with that person (see `Manfrod.Tools.Mcp`,
  `Manfrod.Tools.Kalafiornia`).
  """

  use ManfrodWeb, :live_view

  alias Manfrod.Kalafiornia
  alias Manfrod.Mcp

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(show_add_form: false)
     |> assign(add_form: %{"url" => "", "name" => ""})
     |> assign(adding: false)
     |> load_data()}
  end

  @impl true
  def handle_params(_params, _uri, socket) do
    {:noreply, load_data(socket)}
  end

  @impl true
  def handle_event("toggle_add_form", _params, socket) do
    {:noreply, assign(socket, show_add_form: !socket.assigns.show_add_form)}
  end

  def handle_event("update_add_form", %{"field" => field, "value" => value}, socket) do
    {:noreply, assign(socket, add_form: Map.put(socket.assigns.add_form, field, value))}
  end

  def handle_event("save_custom_provider", _params, socket) do
    %{"url" => url, "name" => name} = socket.assigns.add_form

    if url == "" do
      {:noreply, put_flash(socket, :error, "MCP server URL is required")}
    else
      user_id = socket.assigns.current_scope.user.id
      socket = assign(socket, adding: true)

      case Mcp.create_custom_provider(user_id, url, name) do
        {:ok, _provider} ->
          {:noreply,
           socket
           |> assign(show_add_form: false, adding: false, add_form: %{"url" => "", "name" => ""})
           |> load_data()
           |> put_flash(:info, "Custom MCP server added")}

        {:error, changeset} ->
          errors = Enum.map_join(changeset.errors, ", ", fn {k, {msg, _}} -> "#{k}: #{msg}" end)

          {:noreply,
           socket |> assign(adding: false) |> put_flash(:error, "Could not add server: #{errors}")}
      end
    end
  end

  def handle_event("delete_custom_provider", %{"id" => id}, socket) do
    user_id = socket.assigns.current_scope.user.id
    Mcp.delete_custom_provider(user_id, id)

    {:noreply, socket |> load_data() |> put_flash(:info, "Custom MCP server removed")}
  end

  def handle_event("disconnect_provider", %{"id" => id}, socket) do
    user_id = socket.assigns.current_scope.user.id
    Mcp.disconnect(user_id, id)

    {:noreply, socket |> load_data() |> put_flash(:info, "Disconnected")}
  end

  # ---------------------------------------------------------------------------
  # Kalafiornia — email + emailed-PIN login (no OAuth), see `Manfrod.Kalafiornia`.
  # ---------------------------------------------------------------------------

  def handle_event("kalafiornia_start_login", _params, socket) do
    email =
      (socket.assigns.kalafiornia_connection && socket.assigns.kalafiornia_connection.email) ||
        socket.assigns.current_scope.user.email || ""

    {:noreply, assign(socket, kalafiornia_step: :email, kalafiornia_email: email)}
  end

  def handle_event("kalafiornia_cancel", _params, socket) do
    {:noreply, assign(socket, kalafiornia_step: :status, kalafiornia_pin: "")}
  end

  def handle_event("kalafiornia_update_email", %{"value" => value}, socket) do
    {:noreply, assign(socket, kalafiornia_email: value)}
  end

  def handle_event("kalafiornia_update_pin", %{"value" => value}, socket) do
    {:noreply, assign(socket, kalafiornia_pin: value)}
  end

  def handle_event("kalafiornia_send_pin", _params, socket) do
    email = socket.assigns.kalafiornia_email

    if email in [nil, ""] do
      {:noreply, put_flash(socket, :error, "Email is required")}
    else
      socket = assign(socket, kalafiornia_sending: true)

      case Kalafiornia.request_pin(email) do
        :ok ->
          {:noreply,
           socket
           |> assign(kalafiornia_step: :pin, kalafiornia_sending: false, kalafiornia_pin: "")
           |> put_flash(:info, "PIN sent to #{email}")}

        {:error, reason} ->
          {:noreply,
           socket
           |> assign(kalafiornia_sending: false)
           |> put_flash(:error, "Could not send PIN: #{inspect(reason)}")}
      end
    end
  end

  def handle_event("kalafiornia_verify_pin", _params, socket) do
    user_id = socket.assigns.current_scope.user.id
    email = socket.assigns.kalafiornia_email
    pin = socket.assigns.kalafiornia_pin

    socket = assign(socket, kalafiornia_sending: true)

    case Kalafiornia.login_with_pin(user_id, email, pin) do
      {:ok, _connection} ->
        {:noreply,
         socket
         |> assign(kalafiornia_step: :status, kalafiornia_sending: false, kalafiornia_pin: "")
         |> load_kalafiornia()
         |> put_flash(:info, "Kalafiornia connected")}

      {:error, _reason} ->
        {:noreply,
         socket
         |> assign(kalafiornia_sending: false)
         |> put_flash(:error, "Wrong PIN, try again")}
    end
  end

  def handle_event("kalafiornia_disconnect", _params, socket) do
    user_id = socket.assigns.current_scope.user.id
    Kalafiornia.disconnect(user_id)

    {:noreply, socket |> load_kalafiornia() |> put_flash(:info, "Kalafiornia disconnected")}
  end

  defp load_data(socket) do
    user_id = socket.assigns.current_scope.user.id
    providers = Mcp.providers_for_user(user_id)

    socket
    |> assign(builtin_providers: Enum.reject(providers, & &1.custom))
    |> assign(custom_providers: Enum.filter(providers, & &1.custom))
    |> assign(mcp_connections: Mcp.list_connections(user_id))
    |> load_kalafiornia()
  end

  defp load_kalafiornia(socket) do
    user_id = socket.assigns.current_scope.user.id
    connection = Kalafiornia.get_connection(user_id)

    socket
    |> assign(kalafiornia_connection: connection)
    |> assign_new(:kalafiornia_step, fn -> :status end)
    |> assign_new(:kalafiornia_email, fn ->
      (connection && connection.email) || socket.assigns.current_scope.user.email || ""
    end)
    |> assign_new(:kalafiornia_pin, fn -> "" end)
    |> assign_new(:kalafiornia_sending, fn -> false end)
  end

  # ---------------------------------------------------------------------------
  # Provider card — shared markup for both built-in and custom providers.
  # ---------------------------------------------------------------------------

  attr :provider, :map, required: true
  attr :conn, :any, default: nil
  attr :deletable, :boolean, default: false

  def provider_card(assigns) do
    ~H"""
    <div class="p-4 bg-gray-800 rounded-xl border border-gray-700 flex flex-col gap-4">
      <div class="flex items-center gap-3">
        <.provider_logo provider={@provider} />
        <div class="flex-1 min-w-0">
          <h3 class="text-sm font-semibold text-gray-100 truncate"><%= @provider.name %></h3>
          <%= cond do %>
            <% @provider.mock -> %>
              <span class="text-xs text-gray-500">Coming soon</span>
            <% @conn && @conn.status == "connected" -> %>
              <span class="inline-flex items-center gap-1 text-xs text-green-400">
                <span class="w-1.5 h-1.5 rounded-full bg-green-400"></span> Connected
              </span>
            <% @conn && @conn.status == "expired" -> %>
              <span class="inline-flex items-center gap-1 text-xs text-yellow-400">
                <span class="w-1.5 h-1.5 rounded-full bg-yellow-400"></span> Expired
              </span>
            <% true -> %>
              <span class="text-xs text-gray-500">Not connected</span>
          <% end %>
        </div>
      </div>

      <%= if @provider.mock do %>
        <div class="rounded-lg border border-dashed border-gray-700 px-3 py-2 text-center">
          <span class="text-xs text-gray-500">Coming soon</span>
        </div>
      <% else %>
        <div class="flex items-center justify-between gap-4">
          <%= if @conn && @conn.status in ["connected", "expired"] do %>
            <div class="flex gap-4">
              <a
                href={"/mcp/#{@provider.id}/connect"}
                class="text-xs font-medium text-indigo-400 hover:text-indigo-300"
              >
                Reconnect
              </a>
              <button
                phx-click="disconnect_provider"
                phx-value-id={@provider.id}
                data-confirm={"Disconnect #{@provider.name}?"}
                class="text-xs font-medium text-red-500 hover:text-red-300"
              >
                Disconnect
              </button>
            </div>
          <% else %>
            <a
              href={"/mcp/#{@provider.id}/connect"}
              class="inline-block w-fit px-3 py-1.5 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg"
            >
              Connect
            </a>
          <% end %>

          <%= if @deletable do %>
            <button
              phx-click="delete_custom_provider"
              phx-value-id={@provider.id}
              data-confirm={"Remove #{@provider.name}?"}
              class="text-xs text-gray-500 hover:text-red-400"
            >
              Remove
            </button>
          <% end %>
        </div>
      <% end %>
    </div>
    """
  end

  # ---------------------------------------------------------------------------
  # Provider logos — built-ins render a static asset from priv/static/images/mcp;
  # custom providers render their discovered/none logo.
  # ---------------------------------------------------------------------------

  attr :provider, :map, required: true

  def provider_logo(%{provider: %{id: "granola"}} = assigns) do
    ~H"""
    <img src="/images/mcp/granola.webp" class="w-10 h-10 rounded-lg object-cover" />
    """
  end

  def provider_logo(%{provider: %{id: "firmowid"}} = assigns) do
    ~H"""
    <img src="/images/mcp/firmowid.png" class="w-10 h-10 rounded-lg object-cover" />
    """
  end

  def provider_logo(%{provider: %{logo_url: logo_url}} = assigns) when is_binary(logo_url) do
    ~H"""
    <img src={@provider.logo_url} class="w-10 h-10 rounded-lg object-cover bg-gray-700" />
    """
  end

  def provider_logo(assigns) do
    initial = String.first(assigns.provider.name || "?") |> to_string() |> String.upcase()
    assigns = assign(assigns, :initial, initial)

    ~H"""
    <div class="w-10 h-10 rounded-lg bg-gray-700 flex items-center justify-center text-sm font-semibold text-gray-300">
      {@initial}
    </div>
    """
  end
end
