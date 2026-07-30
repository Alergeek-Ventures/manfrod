defmodule ManfrodWeb.McpLive do
  @moduledoc """
  Top-level "mcp" page — lets any authenticated user (anyone who's ever
  messaged the bot on Slack, since that's the login prerequisite) connect
  their own Linear / Granola accounts, plus any custom MCP server by URL.
  Connections are per-person; the agent picks them up automatically in DMs
  and channel threads with that person (see `Manfrod.Tools.Mcp`).
  """

  use ManfrodWeb, :live_view

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

  defp load_data(socket) do
    user_id = socket.assigns.current_scope.user.id
    providers = Mcp.providers_for_user(user_id)

    socket
    |> assign(builtin_providers: Enum.reject(providers, & &1.custom))
    |> assign(custom_providers: Enum.filter(providers, & &1.custom))
    |> assign(mcp_connections: Mcp.list_connections(user_id))
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
              <.link
                href={"/mcp/#{@provider.id}/disconnect"}
                method="delete"
                data-confirm={"Disconnect #{@provider.name}?"}
                class="text-xs font-medium text-red-500 hover:text-red-300"
              >
                Disconnect
              </.link>
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
  # Provider logos — self-contained SVG marks for built-ins (no external
  # asset requests); custom providers render their discovered/none logo.
  # ---------------------------------------------------------------------------

  attr :provider, :map, required: true

  def provider_logo(%{provider: %{id: "linear"}} = assigns) do
    ~H"""
    <svg viewBox="0 0 32 32" class="w-10 h-10 rounded-lg" style="background:#0f1023">
      <g fill="#fff">
        <rect x="14" y="4" width="4" height="10" rx="1.5" transform="rotate(45 16 16)" />
        <rect x="9" y="4" width="4" height="18" rx="1.5" transform="rotate(45 16 16)" />
        <rect x="19" y="4" width="4" height="18" rx="1.5" transform="rotate(45 16 16)" />
      </g>
    </svg>
    """
  end

  def provider_logo(%{provider: %{id: "granola"}} = assigns) do
    ~H"""
    <svg viewBox="0 0 32 32" class="w-10 h-10 rounded-lg">
      <rect width="32" height="32" rx="8" fill="#F97C4B" />
      <path
        d="M16 6a10 10 0 1 0 7.07 17.07"
        fill="none"
        stroke="#FFF3E8"
        stroke-width="3.4"
        stroke-linecap="round"
      />
      <circle cx="16" cy="16" r="3.4" fill="#FFF3E8" />
    </svg>
    """
  end

  def provider_logo(%{provider: %{id: "firmowid"}} = assigns) do
    ~H"""
    <svg viewBox="0 0 32 32" class="w-10 h-10 rounded-lg">
      <rect width="32" height="32" rx="8" fill="#374151" />
      <text
        x="16"
        y="22"
        text-anchor="middle"
        font-family="ui-sans-serif, system-ui"
        font-size="16"
        font-weight="700"
        fill="#D1D5DB"
      >
        F
      </text>
    </svg>
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
