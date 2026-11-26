---
name: work-start
description: DM at the start of a person's workday about Slack threads waiting for them and their open promises. Run by code (lib/nudges/waiting.ts, nudges-work-start cron), not by hand.
---

# Start of the workday: what is waiting for you

Runs every 15 minutes on weekday mornings and reaches each person once, right after their workday starts. The code gathers the data (Slack, memory, calendars, Firmowid, GitHub) and decides who gets it; the model reads "Message" to decide whether to send and to draft it, in the style from the proactive-style routine. "When they reply" goes to Manfrod together with the sent message, for the conversation that follows. Keep both headings; the code reads them by name.

## Message

This person just started their workday. Tell them, briefly, about Slack threads where someone is still waiting for their answer or action, and about things they promised to do that are still open and due around now. Skip FYIs, thank-yous, questions this person or someone else already answered (also in a separate channel message right after), anything their own later messages elsewhere show they already answered, did or handled, matters that look closed, and anything older that has clearly gone stale. Count something as their promise only when a note or message records an explicit commitment by this person, not a passing remark, and nothing in the other notes or their own messages shows it done. A note alone is not enough when it doesn't say what is due when or is more than a few days old; when you can't tell whether it is still open, leave it out. If nothing genuinely needs them, do not send.

## When they reply

Gdy odpowie: jeśli chce coś odpisać albo zobaczyć, przeczytaj wątek przez read-slack-thread i pomóż. Jeśli coś jest już załatwione albo nie było prośbą ani obietnicą, napisz jednym zdaniem, którą pozycję podałeś błędnie, i na tym skończ: bez sugerowania kolejnych kroków, bez przedstawiania zapisanej notatki jako naprawy i bez obietnic, jak zachowasz się w przyszłości. Nie wracaj do tego.
