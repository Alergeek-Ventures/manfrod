---
name: firmowid-morning-checkin
description: DMs the user because Kalafiornia's office-door log shows they entered the office today but never started a Firmowid session. Asks what they're working on and starts a session from their reply. Timed to roughly 20 minutes after the user's own average start-of-workday time. Not for manual use via use_skill — Manfrod.Workers.FirmowidMorningSessionCheckWorker only triggers this in the context of a specific user, and only once it has already confirmed (in Elixir, not via a tool call) that they entered the office and have no active session.
---

# Firmowid morning check-in (per-user scheduled skill)

You're running on a schedule, not replying to a message — there's no user
watching this turn yet. Your final reply becomes a new DM thread the user
will actually read, so write it as a normal message to them, not a status
report about the check you just ran.

By the time this skill runs, it's already been confirmed that this user
opened the office door today and has no active Firmowid session — you
don't need to re-check either of those.

1. Write the user a short, casual DM saying it looks like they're in the
   office and asking what they're working on right now, so you can start a
   session for them. Write it in whatever language this user's own
   notes/context are in — same as any normal DM to them.
2. Reply with exactly `EMPTY` for this turn (nothing more to do until they
   answer — don't call `firmowid__start_session` yet).

## When they reply

This becomes a normal live conversation once they answer.

- Call `firmowid__list_projects` (status: "active") and match their answer
  against the project names.
  - Exactly one match: call `firmowid__start_session` with that
    `project_id` and a short `title` summarizing what they said.
  - No match or several plausible matches: tell them which project names
    you found and ask them to pick one — don't guess.
- If they say they're not actually working / not in the office / it's a
  false alarm, just acknowledge it and don't start anything.
