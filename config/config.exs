import Config

# Use tzdata for timezone support (needed for trigger scheduling)
config :elixir, :time_zone_database, Tzdata.TimeZoneDatabase

config :manfrod,
  ecto_repos: [Manfrod.Repo],
  generators: [timestamp_type: :utc_datetime, binary_id: true],
  admin_emails: ["franek@alergeek.ventures", "kamil@alergeek.ventures"]

# Kill switches for streamed replies, one per failure domain — both default to
# true and exist so a provider or Slack regression can be worked around
# without a deploy.
#
#   :llm_streaming   - consume the model response as a stream (Manfrod.LLM).
#                      Turn off if streamed tool calls come back malformed;
#                      answers then arrive whole, as they did before.
#   :slack_streaming - render that stream into Slack with chat.startStream
#                      (Manfrod.Slack.ActivityHandler). Turn off to fall back
#                      to a shimmer plus one finished message.
config :manfrod,
  llm_streaming: true,
  slack_streaming: true

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
    {Oban.Plugins.Lifeline, rescue_after: :timer.hours(4)},
    {Oban.Plugins.Cron,
     timezone: "Europe/Warsaw",
     crontab: [
       # Every hour - memory retrospection (slipbox drain)
       {"5 */3 * * *", Manfrod.Workers.RetrospectionWorker},
       # Daily at 2:10am - deep review of the already-integrated graph
       # (duplicates/orphans independent of slipbox state)
       {"10 2 * * *", Manfrod.Workers.GraphReviewWorker},
       # Every hour - schedule reminder triggers for next 12h
       {"0 * * * *", Manfrod.Workers.SchedulerWorker},
       # Every hour - schedule cron-skill triggers for next 12h (skills
       # with a `cron:` frontmatter field; none exist yet)
       {"0 * * * *", Manfrod.Workers.SkillSchedulerWorker},
       # Every hour - refresh/expire user MCP connections
       {"15 * * * *", Manfrod.Workers.McpExpiryWorker},
       # 9am on weekdays - schedules each Firmowid-connected user's
       # forgotten-session check for later that day, timed from their own
       # average end-of-workday time
       {"0 9 * * 1-5", Manfrod.Workers.FirmowidReminderSchedulerWorker},
       # 9pm on Sun-Thu (i.e. the evening before each weekday) - schedules
       # each Firmowid-connected user's "entered the office but forgot to
       # start a session" check for the next morning, timed from their own
       # average start-of-workday time
       {"0 21 * * 0-4", Manfrod.Workers.FirmowidMorningReminderSchedulerWorker},
       # Every hour - roll raw events into the daily usage/adoption tables
       # before the 7-day audit retention drops them
       {"25 * * * *", Manfrod.Workers.RollupWorker},
       # Daily at 3am - refresh the gitleaks secret-pattern ruleset from upstream
       {"0 3 * * *", Manfrod.Workers.GitleaksRulesRefreshWorker}
     ]}
  ]
