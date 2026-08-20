---
name: firmowid-session-check
description: Daily check at a random time between 19:00-20:00 on weekdays, whether the user has a forgotten (active >2h) Firmowid session; if so, DM them suggesting to end/edit it. Not for manual use via use_skill — SkillSchedulerWorker/SkillRunner triggers this automatically in the context of a specific user.
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
4. If it's been running 2 hours or less, reply `EMPTY` (still plausibly a real, ongoing work session).
5. If it's been running more than 2 hours, write the user a DM: mention since when the session has been running, that it looks like it might have been forgotten, and offer to end it (`stop_current_session`) and/or edit it (`edit_session`) to the correct end time if they tell you when they actually stopped working. Write it in whatever language this user's own notes/context are in — same as any normal DM to them.

## When they reply

This becomes a normal live conversation once the user replies — you're no
longer running on a schedule for the rest of it.

- If they tell you when they stopped working, call `edit_session` (or
  `stop_current_session` if they mean right now) with that time, same as
  you would for any request like this.
- If they say they're still working / not done yet, don't just leave it —
  call `schedule_followup_check` for 1 hour from now, with instructions to
  call `firmowid__get_current_session` again and check whether that same
  session has ended. If it has, do nothing. If it's still running, ask
  again (same tone as the first message) and repeat this same "still
  working → schedule another followup_check in 1h" handling — don't just
  fire one followup and give up.
