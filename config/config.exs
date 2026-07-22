import Config

# Use tzdata for timezone support (needed for trigger scheduling)
config :elixir, :time_zone_database, Tzdata.TimeZoneDatabase

config :manfrod,
  ecto_repos: [Manfrod.Repo],
  generators: [timestamp_type: :utc_datetime, binary_id: true],
  admin_emails: ["franek@alergeek.ventures", "kamil@alergeek.ventures"]

config :manfrod, Manfrod.Repo, types: Manfrod.PostgrexTypes

config :manfrod, ManfrodWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  pubsub_server: Manfrod.PubSub,
  live_view: [signing_salt: "5e3ieG0i"],
  render_errors: [formats: [html: ManfrodWeb.ErrorHTML], layout: false]

# Dev-only: code reloading, asset watcher, and live-reload patterns. These
# must stay out of the base config above — the ~r// regex literals compile to
# terms `mix release` refuses to serialize into the release's config.
if config_env() == :dev do
  config :manfrod, ManfrodWeb.Endpoint,
    code_reloader: true,
    watchers: [
      tailwind: {Tailwind, :install_and_run, [:manfrod, ~w(--watch)]}
    ],
    reloadable_compilers: [:elixir],
    live_reload: [
      patterns: [
        ~r"priv/static/(?!uploads/).*(js|css|png|jpeg|jpg|gif|svg)$",
        ~r"lib/manfrod_web/(controllers|live|components)/.*(ex|heex)$"
      ]
    ]
end

if config_env() == :prod do
  # Behind a TLS-terminating reverse proxy (e.g. Coolify/Traefik), trust the
  # X-Forwarded-Proto header so generated URLs (e.g. Google OAuth's
  # redirect_uri) come out as https instead of http. This has to live here
  # (compile-time), not runtime.exs — Phoenix builds the Endpoint's plug
  # pipeline, which force_ssl shapes, at compile time.
  config :manfrod, ManfrodWeb.Endpoint, force_ssl: [rewrite_on: [:x_forwarded_proto]]
end

config :logger,
  handle_otp_reports: true,
  handle_sasl_reports: true

config :logger, :default_formatter,
  format: "[$level] $message\n",
  metadata: [:request_id]

config :phoenix, :json_library, Jason

# Tailwind
config :tailwind,
  version: "4.1.8",
  manfrod: [
    args: ~w(
      --input=assets/css/app.css
      --output=priv/static/assets/app.css
    ),
    cd: Path.expand("..", __DIR__)
  ]

# Oban (job processing)
config :manfrod, Oban,
  engine: Oban.Engines.Basic,
  repo: Manfrod.Repo,
  queues: [default: 10, retrospection: 1],
  plugins: [
    Oban.Met,
    {Oban.Plugins.Pruner, max_age: 60 * 60 * 24 * 7},
    {Oban.Plugins.Cron,
     crontab: [
       # Weekly (Sunday midnight) - memory retrospection (slipbox drain)
       {"0 0 * * 0", Manfrod.Workers.RetrospectionWorker},
       # Daily at 2:10am - deep review of the already-integrated graph
       # (duplicates/orphans independent of slipbox state)
       {"10 2 * * *", Manfrod.Workers.GraphReviewWorker},
       # Every hour - schedule reminder triggers for next 48h
       {"0 * * * *", Manfrod.Workers.SchedulerWorker},
       # Every hour - schedule cron-skill triggers for next 48h (skills
       # with a `cron:` frontmatter field; none exist yet)
       {"0 * * * *", Manfrod.Workers.SkillSchedulerWorker}
     ]}
  ]
