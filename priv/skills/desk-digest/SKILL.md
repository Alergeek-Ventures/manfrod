---
name: desk-digest
description: Sun-Thu 18:00 digest of tomorrow's desk bookings and map, posted automatically to a fixed channel. Skipped Fri/Sat since desks aren't shown a day ahead on weekends. Not for on-demand use via use_skill — SkillSchedulerWorker/SkillRunner triggers this autonomously and feeds you this file's body directly as instructions.
cron: "0 18 * * 0-4"
channel: "C087QF130R3"
---

# Desk digest (cron skill)

You're running on a schedule (18:00 Europe/Warsaw, Sun-Thu only — so
Mon-Fri desks get shown the evening before, and no digest fires on
Fri/Sat evenings), not replying to a message — there's no user to ask
questions or wait for. Just do this:

1. Work out tomorrow's date from the current time given in your system
   prompt.
2. Call `show_desk_map` with tomorrow's date — it posts the map image
   directly to this channel.
3. Reply with one short sentence confirming what you posted (e.g.
   "Wysłałem plan biurek na jutro."). That reply gets posted to this
   channel too, right after the map.

Don't call `list_desk_reservations` as well — the map already shows who has
what; a separate text list would just repeat it.
