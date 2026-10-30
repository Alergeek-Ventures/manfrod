---
name: recurring-jobs
description: Set up, list, change, or cancel jobs that repeat on a calendar schedule with no end ("every day at 8 send me X", "every Friday ask the team for Y", "stop doing that daily thing"). Use whenever the user wants something done automatically at fixed times, not once and not until some goal is reached.
---

# Recurring jobs

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

A recurring job never ends on its own and each run knows nothing about the
previous ones. Something that should stop once a goal is reached ("check
every day until the client answers", "chase everyone until they reply") is a
long-running task (`create-task`), not this. Both together are common: a job
that every Friday asks a channel for something and starts a task to collect
the answers.

## Setting one up

User says "codziennie o 8 rób X", "w każdy poniedziałek przygotuj Y", "raz w
tygodniu zbierz Z" → call `create-recurring-reminder` directly, in the
same turn. You do NOT need to call `create-note` first — the instructions
are stored on the reminder itself.

- `name` — short unique slug (e.g. `morning_brief`, `monday_report`). If
  creation fails because the name is taken, pick a more specific one and
  retry.
- `cron` — standard 5-field cron (`minute hour day-of-month month
  day-of-week`). "codziennie o 8" → `0 8 * * *`. "w poniedziałki o 9" →
  `0 9 * * 1`. Resolve relative/vague timing against `[Current Context]`
  before writing the expression.
- `instructions` — the prompt your future self gets each time it fires; see
  "Writing the instructions" below.
- `timezone` — omit unless the user names one; defaults to Europe/Warsaw.

Confirm briefly with the schedule in human terms ("OK, codziennie o 8:00").

## Writing the instructions

Each run starts from nothing but these instructions, in a new thread in the
owner's DM, weeks after this conversation. Write them so that run can act
without guessing:

- **Self-contained.** Who asked and why, channel IDs, people with their
  Slack IDs and what applies to each of them. Freeze only what the user
  decided; anything that can change (who is on the team, who picked what)
  should be looked up at run time with search-notes or list-team-members,
  and say so.
- **Steps with the tools named**, in order. Your reply in that run only
  reaches the owner's DM, so say where results go: `post-slack-message` for
  a channel, `send-dm` for one person, or the owner's DM. Say what the owner
  should get, e.g. one line with a link to the post.
- **Follow-up over days is a task.** When the run asks people for something
  and has to chase answers, post first, then `create-task` with the
  `channel` and `thread_ts` of that post, a success criterion, the first
  check, and a deadline after which it posts the summary there and closes.
  Never `schedule-followup-check` or `set-reminder` for this: they fire in
  the owner's DM, not in the thread.
- **One run, one task.** If each run starts a task, first check
  `list-tasks` and close the previous run's task if it is still open, so
  they don't pile up.
- **Nothing private.** The instructions are shown in the admin panel and
  the run may post publicly, so leave out pay, health, personal remarks and
  anything said privately that the task doesn't need.

Before creating one that posts in channels or messages other people, tell
the user in two or three lines what it will send, where, and how it follows
up, so they can correct it.

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
