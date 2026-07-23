---
name: holiday-check
description: Daily 13:00 check for public holidays coming up within a week; DMs any team member who hasn't recorded a vacation or work plan for one. Not for on-demand use via use_skill — SkillSchedulerWorker/SkillRunner triggers this autonomously and feeds you this file's body directly as instructions.
cron: "0 13 * * *"
channel: "C0BFLHF7TQ8"
---

# Holiday check (cron skill)

You're running on a schedule (13:00 Europe/Warsaw), not replying to a
message — there's no user watching this turn. Do the check yourself, then
DM the people who need it (each DM is its own separate live conversation
that a real user will read and reply to — don't post the DM content here).

1. Call `list_upcoming_holidays` (default 7 days ahead). If it returns "No
   public holidays..." or an ERROR line, reply with one short sentence
   saying so and stop — nothing else to do.
2. Call `list_team_members` to get everyone to check.
3. For every (holiday date, team member) pair, call `check_holiday_plan`
   with that user's id and the holiday's date.
   - If it says `resolved` or `snoozed`, skip that person — do NOT ask them
     again.
   - If it says `needs_ask`, call `ask_user_about_holiday` with that user's
     id, the date, and the holiday name. This opens a real DM thread for
     them; you won't see their answer in this run.
4. When you're done, reply with one short sentence summarizing what
   happened, e.g. "Sprawdziłem święta na najbliższy tydzień, zapytałem 2
   osoby o Boże Ciało (28.05)." — that's what gets posted to this channel.

Don't ask about a holiday that already has a resolved or snoozed plan, and
don't call `ask_user_about_holiday` more than once per (user, date) pair in
a single run.
