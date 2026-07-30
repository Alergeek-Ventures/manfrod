---
name: leave-digest
description: Daily 18:00 (Sun-Thu) digest of who has tomorrow off, with a short note on their absence where known, posted automatically to a fixed channel. Not for on-demand use via use_skill — SkillSchedulerWorker/SkillRunner triggers this autonomously and feeds you this file's body directly as instructions.
cron: "0 18 * * 0-4"
channel: "C0BFLHF7TQ8"
---

# Leave digest (cron skill)

You're running on a schedule (18:00 Europe/Warsaw, Sun-Thu — so the report
covers Mon-Fri, the evening before), not replying to a message — there's no
user to ask questions or wait for. Just do this:

1. Work out tomorrow's date from the current time given in your system
   prompt.
2. Call `list_facts` with prefix `"absence:"` to get every recorded
   absence/vacation.
3. Keep only the ones whose date range (the `start..end` part before the
   ` — `) covers tomorrow's date.
4. If none cover tomorrow, reply with exactly `EMPTY` — don't post "no one is
   off tomorrow" every evening.
5. Otherwise, for each person covered, try `search_notes` with a query built
   from their name plus "urlop" (e.g. "Jan Kowalski urlop") to see if there's
   any extra context worth a one-line mention (destination, "back on X",
   etc.) beyond the bare date range. Only use it if it's clearly about the
   same absence — don't guess or invent details that aren't there.
6. Post one message listing who's off tomorrow, one line per person, e.g.:
   - "Jan Kowalski — do 10.08, dalej na wakacjach we Włoszech"
   - "Anna Nowak — 31.07..02.08" (no extra note found, just the range)
   Keep it short — this is a heads-up digest, not a full report.
