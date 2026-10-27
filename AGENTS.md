Manfrod is a Slack AI agent with a memory graph, written in TypeScript on eve (agent runtime) and Next.js (admin UI), with Inngest for background jobs and Drizzle on Postgres (ParadeDB). See `docs/port-plan.md` for the architecture.

## Project guidelines

- Run `pnpm format && pnpm typecheck && pnpm test` when done with changes; run `pnpm build` when touching `agent/`, `next.config.ts` or anything imported by both the agent and the web app
- Use the built-in `fetch` for HTTP requests; do not add HTTP client libraries
- **Do not write comments.** Code should be self-explanatory through naming. If something is genuinely non-obvious, one short line is acceptable — never a paragraph or a comment restating what the code does
- Match the surrounding code: ES modules with explicit `.ts` import extensions, named exports, no default exports outside Next.js route/page files

### Pull requests

- Write PR titles and descriptions in **English**, even when the conversation that produced the change was in another language
- Keep the description minimal: a sentence or two per change, no section headings, no test-plan boilerplate
- **Never** put a Claude session link in the PR body

## Layout

- `agent/` is the eve agent root. One tool per file in `agent/tools/<kebab-name>.ts` (the file name is the tool name the model sees), defined with `defineManfrodTool` from `agent/lib/define-tool.ts`; tool-only helpers live in `agent/lib/`
- `agent/subagents/self-modify/` lets admins have Manfrod change its own source: it edits a checkout in the E2B sandbox and opens a draft pull request through the GitHub App (`lib/github.ts`). Its path allowlist lives in `agent/lib/self-modify.ts`. Each pull request it opens is recorded in `self_modify_pulls`; the `self-modify-cleanup` cron (`lib/self-modify-pulls.ts`) deletes the branch and the E2B sandbox once it is closed or merged, and any paused sandbox older than two days
- `lib/self-review/` runs the nightly self-review: it triages 👎-rated threads into findings, starts self-modify for at most two well-evidenced ones (as the `system:self-review` principal, with the same path allowlist as admins) and, on weekday mornings only, DMs raters when a thread is unclear and reports merged fixes in the original thread
- `agent/lib/e2b-sandbox.ts` is a custom eve sandbox provider backed by E2B microVMs; its template (`scripts/build-sandbox-template.ts`, `pnpm sandbox:template`) bakes in the toolchain and `node_modules`, and the `Sandbox template` workflow rebuilds it when dependencies change on `main`
- `lib/` holds all domain code, shared by the agent and the web app. Keep it free of `next/*` imports
- The languages Manfrod writes in (internal vs. client channels) are admin settings in `agent_settings`, edited in the panel's Agent tab; `lib/agent-settings.ts` adds them to every system prompt, so never hardcode a reply language in prompts
- `agent/skills/<name>/SKILL.md` are native eve skills the model loads with `eve__skill`. Prompts run in the background by Inngest (cron skills, Firmowid check-ins) live in `agent/routines/<name>.md`, loaded by `lib/routines.ts`; cron routines declare `cron:` in the frontmatter
- `app/` is the Next.js App Router. Prefer server components and server actions; client components only where interactivity needs them, and never import values from a `"use client"` module into a server component

## eve

- Tool, hook, channel and instruction files are discovered by path; one export per file
- Slack hooks must return quickly: route work fire-and-forget and return `null`
- Per-turn data reaches tools through auth attributes (`lib/agent/context.ts`), not globals

## Database

- The schema is owned by SQL migrations in `db/migrations/` (applied by `scripts/migrate.mjs`, tracked in `ts_schema_migrations`). Add a new numbered `.sql` file for every change and never edit an applied one
- After a migration, run `pnpm db:pull` to regenerate `db/drizzle/` and import tables from `lib/db/schema.ts`
- Memory data is production data that must never be lost: no destructive migrations on `nodes`, `links`, `messages`, `conversations`, `facts` or `users` without an explicit request
- Every memory read filters by access levels (`accessOverlaps` in `lib/memory/access.ts`); never query `nodes` without it outside admin tooling

## Background jobs

- All background work runs as Inngest functions in `lib/inngest/functions.ts`; crons are evaluated in `Europe/Warsaw`
- User-visible scheduled work (reminders, follow-ups, skill triggers) goes through `lib/jobs/index.ts` so it stays listable and cancellable
- Messages Manfrod sends on its own (`lib/nudges/`) gather data in code, let `decide()` in `lib/nudges/compose.ts` choose whether to send and draft it, and respect the per-person `nudge_preferences` (`set-proactive-preferences`) and per-channel `channel_nudges` (`set-channel-summaries`)

## Tests

- Vitest; unit tests in `test/unit`, DB tests in `test/db` run only when `TEST_DATABASE_URL` points at a migrated database
- Do not call real LLM or third-party APIs in tests

## Secrets

- Secrets come from Infisical (`scripts/with-env.mjs`); never print, log or commit secret values
- Agent secrets (`agent_secrets`, `lib/secrets.ts`) reach tools only through `runWithSecrets`, which `defineManfrodTool` applies. Dynamic tools must call it themselves; set `keepSecretPlaceholders: true` on tools that store or publish free text

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
