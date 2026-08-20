---
name: firmowid-session-check
description: Daily check at a random time between 19:00-20:00 on weekdays, whether the user has a forgotten (active >1h) Firmowid session; if so, DM them suggesting to end/edit it. Not for manual use via use_skill — SkillSchedulerWorker/SkillRunner triggers this automatically in the context of a specific user.
cron: "RAND(19:00-20:00) * * 1-5"
scope: user
requires_mcp: firmowid
---

# Firmowid session check (per-user cron skill)

1. Call `firmowid__get_current_session`.
2. If there's no active session, reply with exactly `EMPTY`.
3. If there is an active session, compute how long it's been running (now - start_datetime).
4. If it's been running 60 minutes or less, reply `EMPTY` (still plausibly a real, ongoing work session).
5. If it's been running more than 60 minutes, DM the user: mention since when the session has been running, that it looks like it might have been forgotten, and offer to end it (`stop_current_session`) and/or edit it (`edit_session`) to the correct end time if they tell you when they actually stopped working.
