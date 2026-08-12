defmodule ManfrodWeb.Router do
  use ManfrodWeb, :router

  import ManfrodWeb.UserAuth
  import Oban.Web.Router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_flash
    plug :put_root_layout, html: {ManfrodWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug :fetch_current_scope
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :require_auth do
    plug :require_authenticated_user
  end

  pipeline :admin_only do
    plug :require_authenticated_user
    plug :require_admin
  end

  # Health check endpoint - no auth required
  scope "/api", ManfrodWeb do
    pipe_through :api

    get "/health", HealthController, :index
  end

  # Google OAuth routes - no auth required
  scope "/auth", ManfrodWeb do
    pipe_through :browser

    get "/google", GoogleAuthController, :request
    get "/google/callback", GoogleAuthController, :callback
  end

  # Login page - redirect if already authenticated
  scope "/", ManfrodWeb do
    pipe_through [:browser, :redirect_if_authenticated]

    live "/login", LoginLive
  end

  # Logout
  scope "/", ManfrodWeb do
    pipe_through [:browser, :require_auth]

    delete "/logout", LogoutController, :delete
  end

  # MCP connection OAuth (Linear, Granola, ...) - any authenticated user
  # can connect their own account
  scope "/mcp", ManfrodWeb do
    pipe_through [:browser, :require_auth]

    get "/:provider/connect", McpOauthController, :connect
    get "/:provider/callback", McpOauthController, :callback
    delete "/:provider/disconnect", McpOauthController, :disconnect
  end

  # Temporary local-only impersonation endpoint
  scope "/dev", ManfrodWeb do
    pipe_through :browser

    get "/impersonate", DevImpersonationController, :create
  end

  # Integrations page (MCP connections + other app logins) - any
  # authenticated user (non-admins are funneled here)
  scope "/", ManfrodWeb do
    pipe_through [:browser, :require_auth]

    live_session :integrations,
      on_mount: [{ManfrodWeb.UserAuth, :require_authenticated}] do
      live "/integrations", IntegrationsLive
    end
  end

  # Admin-only LiveView routes - non-admins get bounced to /mcp
  scope "/", ManfrodWeb do
    pipe_through [:browser, :admin_only]

    live_session :admin,
      on_mount: [{ManfrodWeb.UserAuth, :require_authenticated}] do
      live "/", ActivityLive
      live "/chat", ChatLive
      live "/dashboard", DashboardLive
      live "/graph", GraphLive
      live "/retrospection", RetrospectionLive
      live "/admin/access", Admin.AccessLive
      live "/admin/analytics", Admin.AnalyticsLive
    end
  end

  # Oban dashboard - admin only
  scope "/" do
    pipe_through [:browser, :admin_only]

    oban_dashboard("/oban")
  end

  # LiveDashboard for debugging
  import Phoenix.LiveDashboard.Router

  scope "/dev" do
    pipe_through [:fetch_session, :protect_from_forgery]

    live_dashboard "/dashboard"
  end
end
