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

- `agent/` is the eve agent root. One tool per file in `agent/tools/<kebab-name>.ts` (the file name is the tool name the model sees), defined with `defineManfrodTool` from `agent/lib/define-tool.ts`; tool-only helpers live in `agent/lib/`. A tool people call on purpose (not one Manfrod uses on its own to gather context) also goes into `INTENT_TOOLS` in `lib/analytics/index.ts`
- `agent/subagents/self-modify/` lets admins have Manfrod change its own source: it edits a checkout in the E2B sandbox and opens a draft pull request through the GitHub App (`lib/github.ts`), or adds to one of its open pull requests when that one covers the same feature (`list-open-proposals`, `checkout-repo` with `pull_number`). Its path allowlist (`agent/`, `lib/`, `app/`, `components/`, `hooks/`, `test/`, new non-destructive migrations and `db/drizzle/`, minus auth, secrets, the database client, GitHub access and the self-modify/self-review code) lives in `agent/lib/self-modify.ts`. It plans each change, has a Sonnet `coder` subagent write it and a GPT 6.1 Terra `reviewer` subagent review it in the same sandbox (`publish-proposal` only publishes changes with a recorded review in `self_modify_reviews`), and reads `self_modify_lessons`, which the cleanup cron writes from people's corrections to its merged or closed pull requests. Each pull request it opens is recorded in `self_modify_pulls`; the `self-modify-cleanup` cron (`lib/self-modify-pulls.ts`) deletes the branch and the E2B sandbox once it is closed or merged, and any paused sandbox older than two days. The `self-modify-auto-merge` cron (`lib/self-modify-merge/`, protected) squash-merges a self-modify pull request on its own when its head is the commit self-modify published with the reviewer's approval, GitHub's file list only edits at most ten `agent/skills/<name>/SKILL.md` or existing routine `ROUTINE.md` bodies (never `proactive-style`) without new links, Slack IDs, emails or domains, CI is green and two judges (the review model and Jev) see no prompt injection in the diff; at most five a day, behind the panel's Agent tab switch, each decision posted in the self-review channel. Once the commit baked into the running image (`APP_COMMIT` build arg, `.app-commit`) contains it, `lib/rehearsal/` (protected) replays the scenario the change was meant to fix (up to three rated conversations of the self-review finding, or a message written from the admin's request) in a headless session on the `jobs` channel as the original person, and Sonnet judges each reply against the expected behavior; the verdict (fixed, still broken, which reopens the finding, or unclear) goes into the thread. A rehearsal (`kind: "rehearsal"`) runs only the read-only tools in `lib/rehearsal/guard.ts`; every other tool, MCP included, returns a simulated result, the self-modify subagent is cancelled, and the audit and card hooks skip it, so it never posts, persists messages or feeds memory. Its transcripts are cleared by `events-cleanup` after seven days
- `lib/self-review/` runs self-review on weekdays at 03:30 and every two hours from 8 to 20 (`self-review` cron, Warsaw time): Jev judges every conversation in which someone wrote after Manfrod's reply and records an unhappy person as `inferred_bad` feedback (weaker than a 👎: never admin evidence, no follow-up questions or fix notifications); it triages those and 👎-rated threads into findings, dismisses those a commit merged after the last rating already fixes, starts self-modify for well-evidenced ones while fewer than five of its pull requests are open (as the `system:self-review` principal, with the same path allowlist as admins) and, on weekday mornings only, DMs raters when a thread is unclear and reports merged fixes in the original thread
- `lib/tasks/` holds long-running tasks: `create-task` stores a goal, success criterion and check interval in `agent_tasks`, and a `task_check` job wakes Manfrod in the original thread (workdays 8–18) until it closes the task with `update-task`. `send-dm` messages one person and logs it in `sent_dms`, so a reply in that DM is tied back to the task. `request-capability` first lists the open self-modify pull requests (so an existing one is linked or extended instead of duplicated), then posts Approve/Reject buttons only admins can use (`lib/tasks/capabilities.ts`, protected from self-modify); an approval starts self-modify as that admin, and the `capability-sync` cron resumes the paused task once the pull request is merged
- `lib/github/` is Manfrod's access to people's GitHub through the same GitHub App self-modify uses: `/github/webhook` keeps installations, repositories and commits of every branch in `github_*` tables (new repositories backfill 30 days, the `github-sync` cron reconciles, commits are kept 180 days), and `github_accounts` holds each person's OAuth token, login and commit emails. Protected from self-modify
- `agent/lib/e2b-sandbox.ts` is a custom eve sandbox provider backed by E2B microVMs; its template (`scripts/build-sandbox-template.ts`, `pnpm sandbox:template`) bakes in the toolchain and `node_modules`, and the `Sandbox template` workflow rebuilds it when dependencies change on `main`
- `show-card` renders Block Kit cards live in the streamed reply: `agent/hooks/card-stream.ts` reads the tool's input deltas, `lib/slack/card-scan.ts` cuts out each finished element, `lib/slack/cards.ts` validates it against the card catalog and Slack limits and converts it to blocks, and `lib/slack/card-stream.ts` appends them to the thread stream (buffered until the renderer opens it) and has the tool post whatever did not stream
- `agent/sandbox.ts` gives the main agent a files-only sandbox (`agent/lib/attachment-sandbox.ts`) that keeps Slack images and PDFs eve stages for the model in `sandbox_files`; it cannot run commands, and files older than 30 days are deleted by `events-cleanup`. `lib/slack/files.ts` decides which Slack files reach the model
- `lib/office/` is the office map: the layout (rooms, walls, doors, labels in `office_layouts.elements`, desks with grid position, rotation and owner) edited at `/admin/office`, a pure map-state builder and SVG/PNG renderer, and the signed public `/desk-map/<date>.png` URL; `lib/desks.ts` books desks (an owned desk only when its owner is away that day)
- `lib/` holds all domain code, shared by the agent and the web app. Keep it free of `next/*` imports
- The languages Manfrod writes in (internal vs. client channels) are admin settings in `agent_settings`, edited in the panel's Agent tab; `lib/agent-settings.ts` adds them to every system prompt, so never hardcode a reply language in prompts
- `agent/instructions.md` is the system prompt every run gets, background runs included; `agent/instructions/context.ts` adds the rest per turn (thread rules, soul, context, languages, secrets and tasks in conversations, a short preamble in background runs) from `lib/agent/system-prompt.ts`
- `agent/skills/<name>/SKILL.md` are native eve skills the model loads with `eve__skill`. Everything Manfrod does on its own is described in `agent/routines/<name>/ROUTINE.md`, loaded by `lib/routines.ts`: cron skills and Firmowid check-ins (the whole file is the prompt; cron routines declare `cron:` in the frontmatter), and the instructions for every nudge, holiday check and weekly project summary, whose code reads one `## Section` by heading with `routineText()` and fills `{{placeholders}}`. Change what these messages say there, not in TypeScript; keep the headings and placeholders the code reads
- `app/` is the Next.js App Router. Prefer server components and server actions; client components only where interactivity needs them, and never import values from a `"use client"` module into a server component

## Writing tools

- A tool that acts for a person (posts, edits, reads private data) checks that person's access on every path that reaches the data, through one shared helper: a channel name, a channel ID, a file or canvas ID and a DM must all end up in the same membership check. Refuse when access can't be established
- Don't add irreversible operations (delete, overwrite, close, send to many people) that nobody asked for; when one is asked for, say so in the tool description
- Every new tool in `agent/tools/` gets a unit test that covers its access rules and refusals, not only the happy path or the API call shape
- Name new Slack scopes, environment variables and admin settings a change needs in the pull request; the repository has no Slack manifest
- Follow the closest existing tool for the same service and keep its rules (e.g. `post-slack-message` for anything that writes to Slack)

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
- Messages Manfrod sends on its own (`lib/nudges/`) gather data in code, let `decide()` in `lib/nudges/compose.ts` choose whether to send and draft it (its instructions are the `proactive-style` routine plus the nudge's routine), and respect the per-person `nudge_preferences` (`set-proactive-preferences`) and per-channel `channel_nudges` (`set-channel-summaries`)

## Tests

- Vitest; unit tests in `test/unit`, DB tests in `test/db` run only when `TEST_DATABASE_URL` points at a migrated database
- Do not call real LLM or third-party APIs in tests

## Secrets

- Secrets come from Infisical (`scripts/with-env.mjs`); never print, log or commit secret values
- Agent secrets (`agent_secrets`, `lib/secrets.ts`) are personal (owner only) or company (everyone, admins add them), and each is bound to the hosts it may be sent to. They reach tools only through `runWithSecrets`, which `defineManfrodTool` applies: a placeholder is filled in only when the tool declares its destination (`secretHost`, e.g. `http-request`, or the MCP server host) and that host is allowed. Dynamic tools must call it themselves; set `keepSecretPlaceholders: true` on tools that store or publish free text. Values are entered only through the panel's Secrets page or the Slack modal from `request-secret`, never in chat

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
