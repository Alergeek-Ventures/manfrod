---
name: project-summary
description: On-demand summary of what's happened in this project/channel — status, decisions, milestones from notes. Use when asked for the project's status, "what's new", "what happened today/this week", or a summary for a specific date/range. Time-aware: bucket by recency (today vs last 2 days vs last week vs older) unless the user names a specific period.
---

# Project summary

The project is whatever this channel is scoped to (its access level already
limits `list_recent_notes`/`search_notes` to the right notes — no separate
"which project" question needed).

## 1. Work out the time scope from the request

- **A specific date or range is named** ("co było 15 lipca", "między 10 a 20
  czerwca") → use exactly that as `since`/`until`.
- **"Today" / "dzisiaj"** → `since = until =` today's date, from `Now` in
  your current-context system prompt.
- **"Yesterday" / "wczoraj"** → `since = until =` yesterday.
- **No time cue at all** ("jaki jest stan projektu", "co słychać", "podsumuj
  projekt", "co nowego") → no fixed range. Pull a wider window (see step 2)
  and present it tiered by recency (step 3). This is the default case.

Compute date boundaries yourself from `Now` (e.g. today − 1 day, today − 7
days) — don't ask the user to do date math.

## 2. Pull the notes

Call `list_recent_notes` — it lists notes in chronological order (has a real
`inserted_at` date per note), unlike `search_notes` which ranks by semantic
relevance and is the wrong tool here.

- Specific range or "today"/"yesterday" → pass that `since`/`until` directly,
  default `limit` is fine.
- No time cue → call with no `since`/`until` and a larger `limit` (e.g. 200)
  to get a broad recent window in one call, newest first.
- If the user asks about the project's origin/history/"what was the very
  first thing" → call again with `order: "asc"` (and no `since`) to get the
  oldest notes directly, rather than guessing from the tail of a
  newest-first list.

If nothing comes back, say so plainly ("nic nie znalazłem na dziś" /
"brak notatek w tym okresie") — don't pad it out or imply you searched
harder than you did.

## 3. Structure the answer

**Specific date/range or "today"/"yesterday" requested:** one section,
just that window's notes, most recent first. No other tiers.

**No time cue (general "what's the state of things" question):** bucket the
pulled notes into tiers by each note's date vs. `Now`, most detail on the
newest tier, tapering off:

1. **Dzisiaj / Dziś** — today's notes, in full.
2. **Ostatnie 2 dni** — the rest of the last 2 days, in full.
3. **Ostatni tydzień** — 3–7 days ago, can be a bit more condensed (group
   related items).
4. **Wcześniej** — older than a week, summarize briefly (one line per theme,
   not per note) — this tier is about giving orientation, not a full log.

Skip a tier entirely if it's empty rather than saying "nothing here". If the
oldest tier's notes look cut off by the `limit` you passed (result count ==
limit), say there may be older history not shown rather than implying that's
everything.

Keep the whole reply proportionate to what was actually found — a quiet
project gets a short answer, don't manufacture structure over one or two
notes.

## Notes on scope

- `list_recent_notes` reads the same access-scoped notes as `search_notes`/
  `get_note` — it's just ordered by time instead of relevance. If the user
  then asks to drill into one item, use `get_note` with its id.
- If the question is about a specific topic within the project rather than
  general activity ("co się dzieje z fakturami"), prefer `search_notes` for
  that (it's about relevance, not time) — `project-summary` applies when the
  ask is about *when things happened*, not *what's true about X*.
