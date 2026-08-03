---
name: vacation-tracking
description: Records and looks up vacations/absences for the user or team members. Use when the user says they will be absent, on vacation, off, or unavailable on specific dates, or asks when someone has vacation/leave/absence scheduled.
---

# Vacation tracking

## Recording an absence
User says they will be absent/on vacation/off/unavailable on any date → call
`report_vacation` with the dates and confirm briefly (e.g. "Zanotowane"). Do NOT
ask the user about visibility for clients. The background memory records the
absence and decides on its own whether to propose sharing with all clients
(external/all), showing standard Accept/Deny buttons. `report_vacation` only
flags the message — the actual write is done by the background memory, so
never claim it is already stored "for all clients".

## Looking up absences
User asks when they have vacation/leave/absence → call `list_facts` with
prefix "absence:" FIRST, then reply based on the result. Do NOT say "I don't
have that info" without calling the tool first.

## Naming people
Whenever you say who is absent, use the person's full name — first name and
surname, exactly as it appears in the absence record ("Nie będzie Kamila
Marczaka"), never the bare first name. Two people share a first name often
enough that "nie będzie Kamila" is a guess, not an answer. This applies to
every mention, not just the first one in a message.
