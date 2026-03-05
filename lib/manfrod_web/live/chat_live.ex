defmodule ManfrodWeb.ChatLive do
  @moduledoc """
  Placeholder for future chat UI.
  """
  use ManfrodWeb, :live_view

  @impl true
  def mount(_params, _session, socket) do
    {:ok, socket}
  end

  @impl true
  def render(assigns) do
    ~H"""
    <Layouts.app flash={@flash} current_scope={@current_scope}>
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 80vh;">
        <h1 style="margin-bottom: 20px;">Manfrod</h1>
        <p style="color: #666; font-size: 0.9em;">
          Chat UI coming soon.
        </p>
      </div>
    </Layouts.app>
    """
  end
end
