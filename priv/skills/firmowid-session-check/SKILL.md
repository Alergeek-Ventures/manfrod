---
name: firmowid-session-check
description: Daily check at a random time between 19:00-20:00 on weekdays, whether the user has a forgotten (active >1h) Firmowid session; if so, DM them suggesting to end/edit it. Not for manual use via use_skill — SkillSchedulerWorker/SkillRunner triggers this automatically in the context of a specific user.
cron: "RAND(19:00-20:00) * * 1-5"
scope: user
requires_mcp: firmowid
---

# Firmowid session check (per-user cron skill)

You're running on a schedule, not replying to a message — there's no user
watching this turn yet. Your final reply becomes a new DM thread the user
will actually read, so write it as a normal message to them, not a status
report about the check you just ran.

1. Call `firmowid__get_current_session`.
2. If there's no active session, reply with exactly `EMPTY`.
3. If there is an active session, compute how long it's been running (now - start_datetime).
4. If it's been running 60 minutes or less, reply `EMPTY` (still plausibly a real, ongoing work session).
5. If it's been running more than 60 minutes, write the user a DM: mention since when the session has been running, that it looks like it might have been forgotten, and offer to end it (`stop_current_session`) and/or edit it (`edit_session`) to the correct end time if they tell you when they actually stopped working. Write it in whatever language this user's own notes/context are in — same as any normal DM to them.
