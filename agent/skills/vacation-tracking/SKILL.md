---
name: vacation-tracking
description: Records, cancels and looks up vacations/absences for the user or team members. Use when the user says they will be absent, on vacation, off, or unavailable on specific dates, calls a recorded absence off, or asks when someone has vacation/leave/absence scheduled.
---

# Vacation tracking

## Recording an absence
User says they will be absent/on vacation/off/unavailable on any date → call
`report-vacation` with the dates and confirm briefly (e.g. "Zanotowane"). Do NOT
ask the user about visibility for clients. The background memory records the
absence and decides on its own whether to propose sharing with all clients
(external/all), showing standard Accept/Deny buttons. `report-vacation` only
flags the message — the actual write is done by the background memory, so
never claim it is already stored "for all clients".

Say what kind of absence it is:
- `working: true` when the person keeps working, just not from the office:
  a business trip, a client visit, a conference, remote work from elsewhere.
  Never record that as a vacation.
- `details` with the short context in Polish, names spelled exactly as the
  person wrote them ("wyjazd do klienta Scape w Sztokholmie", "L4").

## Correcting an absence
Someone says a recorded absence is wrong (other dates, it's a business trip
and not a vacation, a misspelled place or client) → call `report-vacation`
again with the corrected dates, `working` and `details`. It replaces the
overlapping record instead of adding a second one. Only the person whose
absence it is can correct it this way, since it is recorded for the author
of the message.

## Cancelling an absence
Someone calls a recorded absence off entirely ("będę jednak", "odwołaj
urlop", the trip is cancelled) → call `cancel-vacation` with its dates. It
deletes the record, so nobody is reported absent on those days. Never record
a cancellation with `report-vacation` (e.g. details "odwołany urlop"): that
keeps the person listed as absent. If only part of it is called off, call
`report-vacation` with the remaining dates instead. Only say it is cancelled
once `cancel-vacation` confirms it removed something.

If the person has Firmowid connected, check `firmowid__list_leave_requests`
for a leave request on those dates; if there is one, tell them to withdraw it
in Firmowid themselves, since you can't.

## Looking up absences
User asks when they have vacation/leave/absence → call `list-facts` with
prefix "absence:" FIRST, then reply based on the result. Do NOT say "I don't
have that info" without calling the tool first.

## Naming people
Whenever you say who is absent, use the person's full name — first name and
surname, exactly as it appears in the absence record ("Nie będzie Kamila
Marczaka"), never the bare first name. Two people share a first name often
enough that "nie będzie Kamila" is a guess, not an answer. This applies to
every mention, not just the first one in a message.
