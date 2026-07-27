---
name: recurring-tasks
description: Set up, list, change, or cancel tasks that repeat on a schedule ("every day at 8 do X", "every Monday check Y", "stop doing that daily thing"). Use whenever the user wants something done automatically and repeatedly at a time/day, not just once.
---

# Recurring tasks

These are user-owned cron jobs (`create_recurring_reminder` /
`list_recurring_reminders` / `update_recurring_reminder` /
`delete_recurring_reminder`). They run the same way as the built-in
cron-skills: on schedule, your instructions become a full autonomous agent
turn with all your normal tools — not a plain text ping. Use this for
anything that should *do* something repeatedly, not just remind the user of
something once.

If the user wants a single one-off nudge at a specific moment instead
("przypomnij mi jutro o 10 o spotkaniu") → that's `set_reminder`
/ `list_reminders` / `cancel_reminder`, not this.

## Setting one up

User says "codziennie o 8 rób X", "w każdy poniedziałek sprawdź Y", "raz w
tygodniu przygotuj Z" → call `create_recurring_reminder` directly, in the
same turn. You do NOT need to call `create_note` first — the instructions
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
  Cron-fired turns have no live message to reply to, so if the result should
  reach someone, say explicitly where (e.g. "send the summary to channel
  C0123456").
- `timezone` — omit unless the user names one; defaults to Europe/Warsaw.

Confirm briefly with the schedule in human terms ("OK, codziennie o 8:00").

## Listing / checking

User asks what's scheduled, or you need a reminder's ID before
updating/deleting it → call `list_recurring_reminders`.

## Changing one

User wants a different time, different instructions, or to pause/resume it
→ call `update_recurring_reminder` with the `id` from `list_recurring_reminders`
and only the fields that changed (`cron`, `instructions`, `timezone`,
`enabled`). Changing `cron` cancels and reschedules pending runs
automatically — don't delete and recreate.

## Cancelling

User wants it stopped for good → call `delete_recurring_reminder` with the
`id`. This cancels all pending scheduled runs too. If they just want it
paused temporarily, prefer `update_recurring_reminder` with `enabled:
false` instead of deleting.
