# PLAN: live generative cards in Manfrod (Slack)

Status (2026-11-07): stages 1–4 (code) implemented (`feat/card-stream`, `feat/card-actions`), reviewed APPROVE and QA PASS. Blocked on the user: merging spike PR #181 / this feature PR to `main` (production deploy) and the manual Slack test. "Spike results" and the Stage 3 manual test are still open.

Progress:
- Stage 0: PR #181 hardened (053cf50), CI green, APPROVE. Merge blocked by the auto-mode permission classifier; needs the user.
- Stage 1: done on `feat/card-core` (catalog, converter, `createCardBuilder`, `cardToBlocks` with `dropped`/`warnings`, linear stack scanner, `tableBlock` padding). APPROVE.
- Stage 2: done on `feat/card-stream` (`show-card` tool, `card-stream` hook, per-turn pending buffer, `chat.postMessage` fallback without duplicates, per-message block/table limits, retry without cards on rejected batches, `card_link_*` ack). Two review rounds, APPROVE; adversarial QA PASS, both QA bugs fixed.
- Stage 3: `agent/instructions.md` rule and AGENTS.md layout note done; manual Slack test pending (needs deploy).
- Stage 4: done on `feat/card-actions` (stacked on `feat/card-stream`): reply buttons `{ text, reply: true, style? }`; a click is dispatched through the normal inbound path as `[clicked card button] <label>` from the clicker, with the label read from the card on Slack by block_id + action_id (payload value never trusted); buttons removed only after a successful dispatch; ephemerals for streaming, answered, kicked and unreadable cards. Three review rounds (HIGH hidden-reply and duplicate action_id issues fixed), final APPROVE; adversarial QA bug fixed.

Additional decisions:
- Spike tool and hook removed in Stage 2; `show-card` is blocked in self-review and task runs.
- A send still in flight that cannot be retracted is treated as delivered (prefer a missing card over a duplicate).
- A failed `stopStream` reposts the whole answer (prefer a duplicate over a lost answer).
- Once a card table is in the message, later markdown tables in the text lose their separator line so Slack does not build a second table block.
- Broadcast mentions are neutralized in card text only.

Follow-ups: two reply cards in one message share the per-message claim (a click on one removes reply buttons from both); click claims are per process; `<!subteam^…>` mentions in cards still ping; try `chat.update` before reposting after a failed `stopStream`; renderer `"error"` path has no unit test (needs eve runtime); unify the 2900/3000 section limits in `lib/slack/mrkdwn.ts`.

## Goal

Let Manfrod render rich cards (header, sections, tables, dividers, link buttons) in the middle of a streamed Slack answer, appearing element by element while the model writes, like the Vercel "generative UI for conversational agents" demo (json-render + Chat SDK, https://vercel.com/changelog/json-render-and-chat-sdk-agents).

## Decisions

- Do not add Chat SDK or `@json-render/chat` (it needs `chat@^4.43` as a peer and returns Chat SDK cards, not Block Kit). Do not add `@json-render/core` either. Own zod catalog, own converter to Block Kit.
- The model writes the card through a tool (`show-card`) whose input is a flat `elements` array. Each element renders independently as soon as it closes.
- Cards ride the existing Slack stream as `{type:"blocks", blocks:[...]}` chunks (same queue as text, so order is preserved and text/cards interleave).
- A hook subscribed to `action.input.appended` feeds a small bracket-depth scanner; no partial-JSON parser.
- v1 buttons are link buttons only. Action buttons (needs `action_id` routing and permissions, like `request-capability`) are a later stage.
- Do not use the public channel #świat-według-manfroda for tests. Use a DM with the bot or a private test channel.

## Verified facts

Slack (docs.slack.dev):
- `chat.appendStream` and `chat.stopStream` accept chunk types `markdown_text`, `task_update`, `plan_update`, `blocks`. `stopStream` also takes a top-level `blocks` array rendered at the bottom.
- Chunks are append-only; an earlier block cannot be replaced.
- Limits: 50 blocks per `blocks` chunk, plus 50 more in `stopStream` `blocks`; `markdown_text` 12,000 chars total across the stream; stream must be stopped within 10 minutes; `markdown_text` and `chunks` modes cannot be mixed (we already use `chunks`); `appendStream` Tier 4, `stopStream` Tier 2.

eve 0.83.0:
- `action.input.appended` carries `{callId, inputTextDelta, sequence, stepIndex, toolName, turnId}`: raw, possibly incomplete JSON of the tool arguments. It fires before `actions.requested`.
- It is not in the Slack renderer's rendered event list, but hooks (`agent/hooks/`) can subscribe to any event. Hooks are observe-only, enough for side effects.
- `action.partial` is tool OUTPUT snapshots, not input; not useful here.
- Calls through `eve__tool` / `eve__skill` publish no input deltas. `show-card` is a plain tool file, so it is unaffected.
- Thread is available in the hook through `toolCtx(ctx).msgCtx.channel/threadTs`; the stream through `getStream(channel, threadTs)` (shared state, `lib/slack/state.ts`).

Repo:
- `lib/slack/stream.ts` `StreamSession` already batches chunks every 700 ms and starts the stream with `task_display_mode: "plan"`.
- The stream is created by the renderer (`streamFor` in `lib/slack/renderer.ts`) on `message.appended` or `actions.requested`, which needs the Slack event context for the recipient. A hook cannot create it, so if the model calls the tool before saying anything the stream may not exist yet when deltas arrive.
- Deploy: push to `main` triggers `.github/workflows/deploy-production.yml` (Coolify).

## Stage 0: spike

Goal: answer three questions on real Slack, with minimal throwaway-quality but safe code.

1. Does the hook receive `action.input.appended` for a plain tool with a usable thread and an open stream?
2. Does Slack render a `blocks` chunk containing a `table` block inside a `task_display_mode: "plan"` stream?
3. Are text and blocks ordered correctly when interleaved (text, card, text)?

Files already written on the branch (uncommitted, unformatted, typecheck and tests not yet run):
- `lib/slack/stream.ts`: new `StreamSession.blocks(blocks)`.
- `lib/slack/card-scan.ts`: `createElementScanner()`; emits each completed object of the `"elements"` array.
- `lib/slack/cards.ts`: zod catalog (`header`, `section`, `divider`, `table`), `elementToBlock`, `parseElement`.
- `agent/tools/card-spike.ts`: experimental tool, description says call only when someone explicitly asks for a card spike.
- `agent/hooks/card-spike.ts`: hook that logs deltas (stream state, lengths) and appends validated blocks to the stream.
- `test/unit/card-scan.test.ts`: scanner chunking, braces and escaped quotes inside strings, unfinished element, catalog validation, table block.

Steps:
1. Run `pnpm format && pnpm typecheck && pnpm test`; fix failures. Run `pnpm build` (touches `agent/`).
2. Commit on `spike/card-stream`, open PR (English title/description, no sections, no test plan, no session link), review with Czepialski.
3. Merge (the user explicitly authorized merging this spike), wait for the Coolify deploy to be live.
4. Test on Slack in a DM or private test channel: ask Manfrod for a card spike with text, a header, a section, a table, a divider, then more text. Read the server logs for `Agent.CardSpike` lines.
5. Record findings under "Spike results" below, including whether a stream existed when the first delta arrived.

Acceptance for stage 0: all three questions answered with evidence (log lines, screenshot or description of what Slack showed).

## Spike results

_To be filled after step 4._

## Stage 1: core (after spike)

- Finalize the catalog (header, section, fields, table, context, divider, link buttons) and Slack limits: 50 blocks, 3000 chars per section, one table per chunk, 12k stream text budget.
- Converter in `lib/slack/cards.ts` reusing `fromMarkdown` and the table block from `lib/slack/mrkdwn.ts`.
- Scanner and converter unit tests, including JSON split at every position.

## Stage 2: integration

- Real tool `agent/tools/show-card.ts` through `defineManfrodTool`; add it to `INTENT_TOOLS` in `lib/analytics/index.ts`.
- Hook `agent/hooks/card-stream.ts` replaces the spike hook. Remove `card-spike` tool and hook.
- Solve the missing-stream case: if the stream does not exist when deltas arrive, buffer elements and flush once the renderer creates the stream, or have the renderer expose a way to ensure it.
- Fallback when there is no stream (DMs without streaming, background tasks, stream failure): the tool posts the whole card with `chat.postMessage` blocks. Mark call ids already streamed so the tool does not post twice.
- If an element fails validation after it streamed, it cannot be retracted. The tool result returns the list of dropped elements; the prompt tells the model to call the tool once per turn.
- Tests in `test/unit` (stream session blocks queue and ordering, fallback path). No real Slack or LLM calls in tests.

## Stage 3: prompt, docs, manual test

- Short rule in `agent/instructions.md`: when a card is better than plain text (absence summaries, task status, memory results), and to prefer text otherwise.
- Update docs and the AGENTS.md layout notes if the tool list changes.
- Manual test on Slack: absence summary and task status scenarios.

## Stage 4 (later, separate PR): action buttons

Button clicks need `action_id` routing and permission checks, following the `request-capability` pattern in `lib/tasks/capabilities.ts`.

## Risks

- Slack `blocks` chunk is a new API; spike decides whether the whole approach works. Fallback if it does not: separate message plus `chat.update` every ~500 ms (about 20 updates/min limit).
- Streamed elements are not retractable; a model retry can duplicate a card.
- Cards count toward the 12k character stream budget and the 10-minute stream timeout.
- Hook cannot create the stream; stage 2 must handle the first-delta-before-stream case.

## Process

- Feature branch, small conventional commits, English commit messages and PRs, no comments in code, no Claude session link anywhere, no "Test plan" section in PR descriptions.
- Before each PR: `pnpm format && pnpm typecheck && pnpm test`; also `pnpm build` when touching `agent/`.
- Suggested agents: Kodmistrz implements, Czepialski reviews every diff, KrejziTester probes after deploy, Kierownik orchestrates the final PR with the full feature.
- Reports to the user in Polish.
