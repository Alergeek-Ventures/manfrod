---
name: recurring-tasks
description: Set up, list, change, or cancel tasks that repeat on a schedule ("every day at 8 do X", "every Monday check Y", "stop doing that daily thing"). Use whenever the user wants something done automatically and repeatedly at a time/day, not just once.
---

# Recurring tasks

These are user-owned cron jobs (`create-recurring-reminder` /
`list-recurring-reminders` / `update-recurring-reminder` /
`delete-recurring-reminder`). They run the same way as the built-in
cron-skills: on schedule, your instructions become a full autonomous agent
turn with all your normal tools — not a plain text ping. Use this for
anything that should *do* something repeatedly, not just remind the user of
something once.

If the user wants a single one-off nudge at a specific moment instead
("przypomnij mi jutro o 10 o spotkaniu") → that's `set-reminder`
/ `list-reminders` / `cancel-reminder`, not this.

## Setting one up

User says "codziennie o 8 rób X", "w każdy poniedziałek sprawdź Y", "raz w
tygodniu przygotuj Z" → call `create-recurring-reminder` directly, in the
same turn. You do NOT need to call `create-note` first — the instructions
are stored on the reminder itself.

- `name` — short unique slug (e.g. `morning_brief`, `monday_report`). If
  creation fails because the name is taken, pick a more specific one and
  retry.
- `cron` — standard 5-field cron (`minute hour day-of-month month
  day-of-week`). "codziennie o 8" → `0 8 * * *`. "w poniedziałki o 9" →
  `0 9 * * 1`. Resolve relative/vague timing against `[Current Context]`
  before writing the expression.
- `instructions` — write this as if leaving a note for your future self:
  what to check, what tools to use, what to send and to whom/which channel.
  Cron-fired turns run in a new thread in the owner's DM, so your reply
  only reaches them. If the result should reach anyone else, say explicitly
  where and how: `post-slack-message` for a channel (e.g. "post the summary
  in channel C0123456"), `send-dm` for one person. If it needs replies
  collected over the following days, say so: post first, then `create-task`
  with the `channel` and `thread_ts` of that post, so the checks follow that
  thread and the wrap-up lands there.
- `timezone` — omit unless the user names one; defaults to Europe/Warsaw.

Confirm briefly with the schedule in human terms ("OK, codziennie o 8:00").

## Listing / checking

User asks what's scheduled, or you need a reminder's ID before
updating/deleting it → call `list-recurring-reminders`.

## Changing one

User wants a different time, different instructions, or to pause/resume it
→ call `update-recurring-reminder` with the `id` from `list-recurring-reminders`
and only the fields that changed (`cron`, `instructions`, `timezone`,
`enabled`). Changing `cron` cancels and reschedules pending runs
automatically — don't delete and recreate.

## Cancelling

User wants it stopped for good → call `delete-recurring-reminder` with the
`id`. This cancels all pending scheduled runs too. If they just want it
paused temporarily, prefer `update-recurring-reminder` with `enabled:
false` instead of deleting.
