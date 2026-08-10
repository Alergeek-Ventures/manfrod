---
name: desk-digest
description: Sun-Thu 18:00 digest of tomorrow's desk bookings and map, posted automatically to a fixed channel. Skipped Fri/Sat since desks aren't shown a day ahead on weekends. Not for on-demand use via use_skill — SkillSchedulerWorker/SkillRunner triggers this autonomously and feeds you this file's body directly as instructions.
cron: "0 18 * * 0-4"
channel: "C0BFLHF7TQ8"
---

# Desk digest (cron skill)

You're running on a schedule (18:00 Europe/Warsaw, Sun-Thu only — so
Mon-Fri desks get shown the evening before, and no digest fires on
Fri/Sat evenings), not replying to a message — there's no user to ask
questions or wait for. Just do this:

1. Work out tomorrow's date from the current time given in your system
   prompt.
2. Call `show_desk_map` with tomorrow's date and `channel_id` set to
   `C087QF130R3` — the map image goes to that channel, not to this one.
3. Reply with exactly the single word `EMPTY` (nothing else, no
   punctuation) — the map is the whole digest, so a "wysłałem plan biurek"
   confirmation on top of it would just be noise in this channel.

Don't call `list_desk_reservations` as well — the map already shows who has
what; a separate text list would just repeat it.
