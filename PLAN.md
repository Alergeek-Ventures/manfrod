# PLAN: self-modify auto-merges skill and routine changes, then checks they help

Branch `feat/self-modify-skill-automerge` (worktree `../manfrod-skill-automerge`), from `main` at 3d1244c.

## Goal

Self-modify pull requests that only change Markdown in `agent/skills/<name>/SKILL.md` or `agent/routines/<name>/ROUTINE.md` merge themselves once CI is green and an independent security review finds no prompt injection. After the change is live in production, Manfrod comes back (about 30 minutes later, then repeatedly) and checks in the self-review channel whether conversations that use the changed skill or routine go better than before.

## Acceptance criteria

1. Eligibility is decided in code, on the file list GitHub returns for the pull request's head SHA (not the sandbox):
   - every file matches `^agent/skills/[a-z0-9-]+/SKILL\.md$` or `^agent/routines/[a-z0-9-]+/ROUTINE\.md$` (so `agent/subagents/**/skills` never matches), status added or modified, no deletes or renames;
   - a routine must already exist on `main` and its frontmatter block must be byte-identical before and after; new routines are not eligible;
   - `agent/routines/proactive-style/` is never eligible;
   - total change size under a fixed limit; secrets scan (`lib/security/gitleaks.ts`) passes.
2. CI (`ci.yml` check runs) on the head SHA is green.
3. Security review on that exact head SHA, independent of the self-modify session: input is only the diff, the previous file contents and the finding's evidence, as JSON data. Never the PR title/body or self-modify's reasoning. Two independent judges, both must pass:
   - the review model (`REVIEW_MODEL`, GPT 6.1 Terra) via `generateSimple`, structured verdict, no tools;
   - Jev (`typeSafeAi.decisionModel(config.decisionModel)` with `decide`), a choice question.
   Checks: instructions to send data or secrets anywhere, new DM/channel recipients or posting targets, disabling or weakening rules or safety, text that addresses the model as instructions coming from a user, URLs or hosts not already present, content copied from user messages. An LLM can only block, never override the code gate. A failed judge call blocks (fail closed).
4. Merge only through a cron in code, never a tool the agent can call: mark ready for review, merge with the head `sha` parameter (a later commit blocks it). Max 5 auto-merges per rolling 24 hours. Kill switch: admin setting in `agent_settings`, editable in the panel's Agent tab.
5. Every decision (merged, blocked and why) is posted to the self-review channel (`config.selfReviewChannelId`): in the finding's thread when the PR came from self-review, otherwise as a new message. No admin DMs.
6. Deploy detection: production knows its commit from `APP_COMMIT` (set by `deploy-production.yml` from `github.sha` through the Coolify env API before the deploy). A check counts the merge as live when the GitHub compare API says `APP_COMMIT` is identical to or ahead of the merge commit. Missing `APP_COMMIT` means "not yet known", never "live".
7. Once live, Manfrod gets an `agent_tasks` task in that self-review thread (check every 30 minutes, workday hours as tasks already do) with a goal and success criterion, and a new tool that reports, for the changed skill or routine, uses and negative ratings (`bad`, `inferred_bad`) before vs after the deploy with links. Skill use comes from `audit_events` `action_started` of the skill-loading tool (7-day retention). It closes the task with a verdict (better / no change / worse / not enough data after N days) and posts it in the thread. On "worse" it says so and recommends a revert; it does not revert on its own (follow-up).
8. New code that decides merges lives in self-modify-protected paths (added to `BLOCKED` in `agent/lib/self-modify.ts`); `ALLOWED` unchanged.
9. Unit tests for: path and frontmatter eligibility (incl. subagents skills, proactive-style, new routine, deletes), daily limit, kill switch, fail-closed review, SHA race, "contains merge" logic. DB tests where the repo already has them for this area. No real LLM or GitHub calls in tests.
10. `pnpm format && pnpm typecheck && pnpm test && pnpm build` pass. AGENTS.md updated (self-modify paragraph).

## Steps

1. Implement 1–5, 8, 9 (gate, review, merge cron, channel posts, setting, migration). Status: done (`lib/self-modify-merge/`, migration 0029, Agent tab switch)
2. Implement 6, 7 (APP_COMMIT, live detection, verification task and impact tool). Status: done (`self-modify-impact` tool; CI step in its own commit, to show the user)
3. Independent review, fix loop. Status: todo
4. PR (draft). Status: todo

## Decisions

- Auto-merge applies to every self-modify PR, whoever started it (admin, self-review from 👎 or `inferred_bad`). User decision 2026-11-17.
- Limit 5 per rolling 24 h. Reports in the self-review channel, not DMs. User decision.
- Deploy detection by `APP_COMMIT` from `github.sha`, not Coolify's `SOURCE_COMMIT`. User decision. The shared `coolify-deploy` action only syncs Infisical envs, so our workflow sets `APP_COMMIT` with its own Coolify API call (`PATCH /api/v1/applications/{uuid}/envs`) before deploying. CI change: shown to the user before it is merged.
- If Coolify builds a newer `main` than `github.sha` (two quick pushes), `APP_COMMIT` lags; that only delays detection, never a false "live".
- No `/version.json` endpoint. User decision.
- Reverting a harmful change stays manual in v1.
- Branch protection bypass for the GitHub App on `main`: the user does it in repo settings.

## Status

2026-11-17: plan written, implementation starting.
