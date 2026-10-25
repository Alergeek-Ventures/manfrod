# Manfrod

Slack AI agent with a memory graph, skills and integrations. TypeScript on
[eve](https://eve.dev) + Next.js, Inngest for background jobs, Drizzle on
Postgres (ParadeDB). Architecture and the Phoenix → TypeScript mapping are in
[`docs/port-plan.md`](docs/port-plan.md).

## Development

```sh
docker compose -f deployment/local/compose.yml up -d   # ParadeDB + Inngest dev server
pnpm install
pnpm db:migrate
pnpm dev                                                # http://localhost:35233
```

The Inngest dev UI is at http://localhost:8288. Run the dev server with
`INNGEST_DEV=1` so the SDK talks to it.

`pnpm dev` and `pnpm dev:slack` start with `DISABLE_CRONS=1`: scheduled
functions (skill crons, Firmowid checks, retrospection, maintenance, ...) are
not registered, so a local instance never messages people on its own.
Event-driven work (reminders you set while testing, memory extraction) still
runs. Use `DISABLE_CRONS=0 pnpm dev` to turn crons on.

### Testing on Slack locally

`pnpm dev:slack` runs eve dev on :4274, Next on :35233 and a Socket Mode
bridge that uses `SLACK_APP_TOKEN` to forward events, interactivity and slash
commands to the local agent, so no tunnel or Request URL change is needed.
Use a separate dev Slack app: Socket Mode spreads events across every open
connection of an app, so pointing it at the production app's token steals
production traffic.

## Environment

Commands run through `scripts/with-env.mjs`, which loads shared values from
Infisical `dev` at `/app` and then applies local overrides from
`.env.worktree`.

```sh
infisical login --domain="https://infisical.alergeek.me"
touch .env.worktree
```

To work offline, skip Infisical with `AV_SKIP_INFISICAL=1`.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js + eve dev server, production build, migrate and start |
| `pnpm dev:slack` | Local dev with the Slack Socket Mode bridge |
| `pnpm db:migrate` | Apply `db/migrations/*.sql` |
| `pnpm db:pull` | Regenerate the Drizzle schema from the database |
| `pnpm db:verify` | Check that memory data is intact (counts, embeddings, access, links, BM25, Linear keys) |
| `pnpm typecheck` / `pnpm test` | `tsc` and vitest (`TEST_DATABASE_URL` enables DB tests) |
| `pnpm slack:export [n]` | Export recent Slack messages to `eval/slack_raw.json` |
| `pnpm eval:memory [--dry-run] [--scope kind]` | Memory classification eval against `eval/dataset.json` |
| `pnpm desk-map [date] [out.png]` | Render the desk map for a day |

## Sign-in

Web sign-in uses [Better Auth](https://better-auth.com) with Google (Workspace
domain `alergeek.ventures`, sign-up disabled: only people who already exist as
Manfrod users can sign in). The Google redirect URI stays
`https://<host>/auth/google/callback`. `BETTER_AUTH_SECRET` is optional; without
it the secret is derived from `LINEAR_ENCRYPTION_KEY`. Google tokens (also used
for Calendar) live in the `account` table; migration `0005` copied them over
from `google_identities`.

## Agent secrets

Admins manage secrets in the web app (Admin → Secrets). Values are encrypted
with the vault key (`LINEAR_ENCRYPTION_KEY`) and never shown again. Skills and
instructions reference them as `{{ SECRET_NAME }}`: the model only ever sees
the placeholder, the value is substituted into tool arguments when a tool
runs, and tool results have the value swapped back to the placeholder. Tools
that store or publish text (notes, souls, reminders, holiday plans) keep
placeholders as-is, so a secret never lands in memory or in Slack.

## Slack app configuration

In [api.slack.com/apps](https://api.slack.com/apps) → your app:

- **Socket Mode**: off. Events arrive over HTTP.
- **Event Subscriptions**: Request URL `https://<host>/eve/v1/slack`. Bot
  events: `app_mention`, `message.im`, `message.channels`, `message.groups`,
  `assistant_thread_started`, `app_home_opened`, `app_context_changed`.
- **Interactivity & Shortcuts**: Request URL `https://<host>/eve/v1/slack`.
  Message shortcut "Wyrzuć Manfroda" with callback ID `kick_manfrod`.
- **Slash Commands** `/status-manfrod`, `/add-user`, `/linear-status`: Request
  URL `https://<host>/eve/v1/slack`.
- **Agents & AI Apps**: enabled (adds `assistant:write`, needed for suggested
  prompts, titles and streaming status).
- **Basic Information → Signing Secret** goes into `SLACK_SIGNING_SECRET`.

Everything degrades rather than breaks if a piece is missing: without
`assistant:write` there are no prompts, titles or shimmer, but replies still
stream; if `chat.startStream` fails the answer is posted as one message.
`SLACK_STREAMING=false` turns streaming off.

## Deployment

Production runs on Coolify as three separate resources: a ParadeDB database
(with scheduled backups to S3), Inngest, and the app built from `Dockerfile`
on port 35233 with a persistent volume at `/app/.eve/.workflow-data`. Pushes
to `main` deploy the app through `.github/workflows/deploy-production.yml`,
which syncs secrets from Infisical. `LINEAR_ENCRYPTION_KEY` must stay the same as before, or stored Linear keys
cannot be decrypted. After the first deploy, run `pnpm db:verify` against the
production database.
