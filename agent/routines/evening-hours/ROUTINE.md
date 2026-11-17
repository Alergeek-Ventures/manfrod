---
name: evening-hours
description: Evening DM proposing the Firmowid hours a person is missing for today. Run by code (lib/nudges/hours.ts, nudges-hours cron at 19:00 on workdays), not by hand.
---

# Evening hours check

Runs at 19:00 on workdays for people with Firmowid connected. The code gathers the data (Slack, memory, calendars, Firmowid, GitHub) and decides who gets it; the model reads "Message" to decide whether to send and to draft it, in the style from the proactive-style routine. "When they reply" goes to Manfrod together with the sent message, for the conversation that follows. Keep both headings; the code reads them by name.

## Message

It is the evening of a workday. Check whether this person's Firmowid sessions for today cover the work they apparently did. If they have no session today, ask whether to add today's hours: propose concrete entries (Firmowid project, start–end, short title) built from the signals below, or simply ask what they worked on if there are no signals. If they have sessions but the signals clearly show work that is missing (meetings, commits or a stretch of activity for another project, or hours outside any session), propose adding just that. Skip short incidental things: a quick chat, a brief call or a meeting under about 15 minutes is not an entry on its own and is no reason to send; propose only longer stretches of work. Use the Firmowid project names given. Keep it to a short question with the proposed entries, not a report of the signals. If today's sessions already cover the day, or the pattern shows they don't work on this weekday, do not send.

## When they reply

Gdy odpowie: najpierw ustal dokładnie, co wpisać (projekt, godziny, tytuł), jeśli czegoś brakuje. Potem dodaj wszystkie wpisy jednym wywołaniem firmowid__add_sessions: project_id z firmowid__list_projects, tytuł, is_remote (null, jeśli nie wiadomo) oraz start_datetime i end_datetime z offsetem strefy Europe/Warsaw (np. 2026-11-04T09:00:00+01:00). Wpisy nie mogą nachodzić na siebie ani na inne sesje z tego dnia; trwającej sesji nie ruszaj. Jeśli Firmowid odrzuci wpis (błąd wskazuje sessions.<index>), popraw go albo dopytaj. Na koniec potwierdź krótko, co wpisałeś. Jeśli napisze, że nie pracował albo że nic nie trzeba, przyjmij to i nie wracaj do tego.
