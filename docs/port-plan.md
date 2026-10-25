# Manfrod: Elixir/Phoenix → TypeScript (eve + Next.js) port

Status: implemented on branch `eve-typescript-port`. This document is the
reference for what moved where, what changed on purpose, and how production
data carries over.

## Goals

1. Feature parity with the Phoenix app: Slack agent, passive memory
   (classifier, slipbox, retrospection), facts, reminders, cron skills,
   MCP/Linear/Google/Kalafiornia/Firmowid integrations, admin web UI, analytics.
2. Zero data loss. The new stack runs on the **same Postgres (ParadeDB)
   database and the same tables**. Memory (nodes, links, conversations,
   messages, facts, souls) is read and written in place, with identical
   semantics (pgvector cosine distance, ParadeDB BM25, access arrays).
3. A layout that lets the agent change itself later: skills, prompts and
   tools are plain files, so a self-modification worker can open PRs against
   them.

## Target stack

| Concern | Phoenix (before) | TypeScript (after) |
| --- | --- | --- |
| Agent loop, sessions | `Agent.Server` GenServer per thread | eve 0.83 durable sessions (one per Slack thread) |
| Slack transport | Socket Mode (websockex) | eve `slackChannel` (HTTP Events API) + route wrapper for custom interactivity |
| Streaming replies | `StreamSession` (`chat.startStream`) | Slack renderer + `lib/slack/stream.ts` (same API calls) |
| Respond/ignore gate | LLM prompt on the fast model | Jev (`@ai-sdk/typesafe-ai`, `jev-latest`), fast-model prompt as fallback |
| LLM client | ReqLLM over OpenRouter with fallback chain | AI SDK v7 + OpenRouter provider, same fallback chain |
| DB | Ecto + Postgrex | Drizzle ORM + node-postgres, schema introspected with `drizzle-kit pull` |
| Jobs / cron | Oban + Oban cron | Inngest (self-hosted), `jobs` table kept as the reminder registry |
| PubSub / live UI | Phoenix PubSub + LiveView | `audit_events` + Postgres `LISTEN/NOTIFY` + SSE |
| Web UI | LiveView pages | Next.js 16 App Router (server components + server actions) |
| Encryption | Cloak AES.GCM.V1 | byte-compatible AES-256-GCM (`lib/vault.ts`) |
| Images | `image` (libvips) | `sharp` |

Process topology: one Node app plus an Inngest server. `next start` serves the
admin UI and, through `withEve`, starts the built eve server on 127.0.0.1:4274
and proxies `/eve/v1/*` to it. Slack posts to `https://<host>/eve/v1/slack`;
Inngest calls `http://app:35233/api/inngest`, which Next forwards to the eve
`jobs` channel.

## Repository layout

```
agent/                 eve agent root
  agent.ts             model, context window, build externals
  instructions/        dynamic system prompt (soul, notes, context, secrets)
  channels/slack.ts    Slack hooks, renderer, interactivity/slash-command/shortcut wrapper
  channels/jobs.ts     Inngest serve endpoint (/api/inngest)
  memory/notes.ts      memory slot: per-turn "[Note context]" recall
  hooks/audit.ts       audit events, LLM usage, assistant message persistence
  tools/               one file per tool (kebab-case name) + dynamic MCP/Linear tools
  lib/                 tool helpers and the defineManfrodTool wrapper
  skills/              native eve skills (SKILL.md), loaded with eve__skill
  routines/            background prompts run by Inngest (cron skills, Firmowid check-ins)
app/                   Next.js admin UI, OAuth routes, health, Inngest proxy
components/            shared UI
lib/                   domain code shared by agent and web
  db/                  drizzle client; schema re-exported from db/drizzle
  memory/              nodes, links, search, classifier, buffer, extractor, retrospector, access
  inngest/             client, event names, functions, runtime context
  jobs/                jobs registry (enqueue/cancel/list) and job execution
  slack/               Web API, mrkdwn, routing/gate, stream, feedback, kick, interactivity
  prompts/             verbatim prompts (classifier, zettelkasten, ...)
db/migrations/         SQL migrations (0000 is the exact Ecto schema)
db/drizzle/            output of `pnpm db:pull`
scripts/               migrate, db-pull, verify-data, eval-memory, slack-export, desk-map
test/                  vitest (unit + DB tests behind TEST_DATABASE_URL)
```

## Module mapping

| Elixir | TypeScript |
| --- | --- |
| `Manfrod.Memory` (+ `Node`, `Link`, `Message`, `Conversation`, `RecurringReminder`, `Project`) | `lib/memory/*.ts` |
| `Memory.Access`, `ChannelMapping`, `ChannelDetector` | `lib/memory/access.ts`, `lib/memory/channel-detector.ts` |
| `Memory.Buffer` (GenServer) | `memory_buffer` table, flushed by the `memory-buffer-flush` function (8 messages or 60 s debounce) |
| `Memory.Classifier` | `lib/memory/classifier.ts` |
| `Memory.PendingOps` / `PendingConfirmations` (ETS) | `memory_pending_ops` / `memory_pending_confirmations` tables |
| `Memory.Extractor`, `FlushHandler` | `lib/memory/extractor.ts`, `extract-session` function debounced 1 min |
| `Memory.Retrospector` | `lib/memory/retrospector.ts`, `retrospection` cron |
| `Memory.QueryExpander`, `Voyage`, `BraveSearch` | `lib/memory/query-expander.ts`, `lib/voyage.ts`, `lib/brave.ts` |
| `Agent.Server` turn loop | eve harness |
| `Agent.Server` batching / gate / catch-up / restore | `lib/slack/routing.ts` + `lib/agent/turns.ts` |
| `Agent.ResponseGate`, `PlanTitle`, `ThreadTitle` | `lib/agent/response-gate.ts`, `lib/agent/titles.ts` |
| `Agent.Init`, system prompt, `Soul.base_prompt` | `lib/agent/prompts.ts`, `lib/agent/system-prompt.ts` |
| `Tools.*` | `agent/tools/<tool-name>.ts` |
| `Skills`, `SkillRunner` | `agent/skills/` (on-demand), `lib/routines.ts` + `lib/jobs/execute.ts` (scheduled runs are eve sessions) |
| `Proactive`, `TriggerWorker` | `lib/proactive.ts`, `run-job` / `proactive-send` functions |
| `Slack.*` | `lib/slack/*.ts` |
| `Events`, `Persister`, `Store` | `lib/events/*.ts`, `agent/hooks/audit.ts` |
| `Analytics`, `Rollup`, `Pricing` | `lib/analytics/*.ts`, `lib/pricing.ts` |
| `Mcp.*` | `lib/mcp/*.ts` |
| `Linear.*`, `Encrypted.Binary`, `Vault` | `lib/linear/*.ts`, `lib/vault.ts` |
| `Google.*`, `Kalafiornia.*`, `Firmowid.SessionStats` | `lib/google.ts`, `lib/kalafiornia.ts`, `lib/firmowid.ts` |
| `Security.*` | `lib/security/*.ts` (vendored `gitleaks.toml`) |
| `Desks`, `DeskMap` | `lib/desks.ts`, `lib/desk-map.ts` |
| `Facts`, `Feedback`, `Accounts` | `lib/facts.ts`, `lib/feedback.ts`, `lib/accounts.ts` |
| Oban workers and crons | `lib/inngest/functions.ts` |
| `ManfrodWeb.*` LiveViews and controllers | `app/**` |
| `mix eval.memory`, `mix slack.export`, `generate_desk_map.exs` | `scripts/*.ts` |

### Background functions (Inngest, `TZ=Europe/Warsaw`)

| Function | Trigger |
| --- | --- |
| `run-job` | `jobs/scheduled` — sleeps until `scheduled_at`, cancelled by `jobs/cancelled` |
| `proactive-send` | `proactive/requested` |
| `extract-session` | `session/activity`, 1 min debounce |
| `memory-buffer-flush` | `memory/buffer-pushed`, 60 s debounce |
| `retrospection` | `5 */3 * * *` |
| `graph-review` | `10 2 * * *` |
| `reminder-scheduler`, `skill-scheduler` | hourly |
| `firmowid-evening-scheduler`, `firmowid-morning-scheduler` | `0 9 * * 1-5`, `0 21 * * 0-4` |
| `analytics-rollup` | `25 * * * *` |
| `gitleaks-refresh` | `0 3 * * *` |
| `mcp-expiry` | `15 * * * *` |
| `maintenance` | `*/5 * * * *` (re-dispatch undispatched jobs, prune state) |
| `events-cleanup` | `40 * * * *` |

## Data migration

The database is not copied anywhere: the new app connects to the existing
`DATABASE_URL`.

1. `0000_baseline.sql` is the exact DDL produced by the Ecto migrations,
   idempotent. On production it is a no-op; on an empty database it creates
   the full schema.
2. `0001_runtime_tables.sql` adds tables that replace in-memory/ETS and Oban
   state: `jobs` (with `dispatched_at`), `memory_buffer`,
   `memory_pending_ops`, `memory_pending_confirmations`, `proactive_threads`.
3. `0002_import_oban_jobs.sql` copies every not-yet-run Oban job of the
   user-facing workers (one-time reminders and follow-ups, recurring reminder
   occurrences, Firmowid session checks) into `jobs`, **keeping the same ids**,
   so a reminder the agent called `#123` is still `#123`. On boot the
   `maintenance` function hands every undispatched job to Inngest. `oban_jobs`
   is left untouched for rollback.
4. `0003_db_defaults.sql` adds DB-side defaults (`gen_random_uuid()`,
   `timezone('UTC', now())`) and an `updated_at` trigger, which Ecto used to
   fill in client-side.
5. `0004_agent_secrets.sql` adds `agent_secrets` (new feature, see README).
   `0005_better_auth.sql` adds Better Auth's `session`, `account` and
   `verification` tables plus `users.email_verified`/`image`, and copies every
   `google_identities` row (Google subject, access/refresh token, expiry) into
   `account`, so Calendar access keeps working without a new consent.
   `google_identities` and `user_tokens` are left in place for rollback.
6. Applied migrations are tracked in `ts_schema_migrations`; Ecto's
   `schema_migrations` stays. `scripts/migrate.mjs` refuses to run when
   `schema_migrations` is behind the last Phoenix migration
   (`20261015221309`), because the baseline only creates missing tables and
   cannot add columns to existing ones.

What carries over unchanged: users and souls, the whole zettelkasten (nodes
with their 1024-d Voyage embeddings, links with context), access levels,
conversations/messages, facts, projects/channel mappings/memberships,
recurring reminders, desks and reservations, MCP/Google/Kalafiornia
connections and OAuth clients, encrypted Linear keys (same
`LINEAR_ENCRYPTION_KEY`), thread kicks, feedback, rollups, audit events.

Conversation continuity: the first message in a Slack thread after the switch
seeds a new eve session from `messages` (DMs: up to 400 messages, no age
cutoff; channel threads: 60 messages from the last 24 h), the same restore
rule `Agent.Server` used.

Verification: `pnpm db:verify` checks row counts, embedding dimensions, access
arrays, link and soul integrity, the BM25 index, a hybrid search, Linear key
decryption and the Oban import. Run it before and after the cutover.

## Deliberate differences

- Slack Events arrive over HTTP instead of Socket Mode. The app needs a public
  URL and `SLACK_SIGNING_SECRET`.
- Web login moved to Better Auth; sessions do not survive the switch, users
  sign in once more (same Google redirect URI).
- MCP tools from custom providers are named `c<8 hex>__<tool>` instead of
  `<uuid>__<tool>` (tool names must start with a letter and fit 64 chars).
  Built-in providers keep `firmowid__<tool>`.
- A follow-up from the running turn's author steers it; anyone else's message
  queues behind it (same outcome as the old interrupt/wait split).
- The gate uses Jev when `TYPESAFE_AI_API_KEY` is set and falls back to the
  fast-model prompt otherwise; on any failure it responds.

## Operations

- Env: `DATABASE_URL`, `APP_URL`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
  `OPENROUTER_API_KEY`, `TYPESAFE_AI_API_KEY`, `VOYAGE_API_KEY`,
  `BRAVE_SEARCH_API_KEY`, `GOOGLE_*`, `HOLIDAY_CALENDAR_ID`,
  `KALAFIORNIA_OFFICE_ACCESS_API_KEY`, `LINEAR_ENCRYPTION_KEY`,
  `INNGEST_BASE_URL`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `E2B_API_KEY`.
  `SLACK_APP_TOKEN`, `ZEN_API_KEY`, `GROQ_API_KEY`, `SECRET_KEY_BASE` are no
  longer used.
- Build: `pnpm build` (eve build + next build). Start: `pnpm start`
  (migrations, then `next start`).
- Coolify: separate resources for ParadeDB, Inngest and the app. eve
  workflow state lives in `.eve/.workflow-data` on a volume.

## Future: self-modification

Skills, prompts and tools are files. eve's remote self-modification extension
requires Vercel, so when self-hosting the next step is a worker (Claude Agent
SDK in a container sandbox) that reads negative `message_feedback`, edits
`agent/skills/**` and `agent/routines/**`, and opens a draft PR with a GitHub App token held outside the
sandbox.
