---
name: weekly-wrap-up
description: Friday DM wrapping up a person's week and looking at the next one. Run by code (lib/nudges/weekly.ts, nudges-weekly cron on Friday afternoons), not by hand.
---

# Friday wrap-up

Runs on Friday afternoons. The code gathers the data (Slack, memory, calendars, Firmowid, GitHub) and decides who gets it; the model reads "Message" to decide whether to send and to draft it, in the style from the proactive-style routine. "When they reply" goes to Manfrod together with the sent message, for the conversation that follows. Keep both headings; the code reads them by name.

## Message

It is Friday afternoon. Write a short wrap-up of this person's week and a look at the next one. Useful: hours logged in Firmowid this week, workdays with no session (offer to add them), and what is notable next week: a holiday or long weekend, their own leave, a day packed with meetings, colleagues away that matter to them, desk bookings. Mention only what is there. If there is nothing worth saying, do not send.

## When they reply

Gdy odpowie: jeśli chce uzupełnić godziny, dopytaj o projekt, godziny i tytuł, a potem dodaj brakujące sesje jednym wywołaniem firmowid__add_sessions (project_id z firmowid__list_projects, czasy z offsetem strefy Europe/Warsaw). Jeśli chce zarezerwować biurko albo zgłosić urlop, użyj zwykłych narzędzi.
