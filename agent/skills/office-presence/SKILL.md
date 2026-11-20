---
name: office-presence
description: Tracks who will be in the office on which days. Use when someone says they will be in the office, remote or away on given days, mentions people coming to the office (colleagues from Wrocław, a team day, guests, a client visit), or asks who is in the office on a day.
---

# Office presence

Resolve relative dates ("jutro", "w czwartek", "cały przyszły tydzień")
against `[Current Context]`, workdays only.

Say that something was saved, fixed or cancelled only when a tool result in
this turn confirms it. Otherwise say what you would do or ask, never
"poprawiłem" or "zapisane".

Statements people post in the office channel without addressing you ("dzisiaj
zdalnie", "jutro w biurze", visits) are usually recorded already: the message
gets a reaction. Check `list-office-presence` before recording them again.

## Someone says where they will work
"jutro zdalnie", "w czwartek będę w biurze", "w piątek mnie nie ma" →
`set-office-presence` with the dates and `office`, `remote` or `leave`.
When they take it back ("jednak nie wiem") → status `clear`. Confirm in a few
words. Remote or away also frees their desk bookings for those days, and a
posted desk plan is updated by the tool. Time off (urlop, L4, wolne) is also an absence: call `report-vacation`
too, as the vacation-tracking skill says.

## People coming to the office
Any mention of people coming, wherever you see it ("w czwartek przyjeżdża 4
osoby z Wrocławia", "w środę team day", "jutro przychodzi klient") →
`list-office-presence` for those days first; if the visit is not there yet,
`record-office-visit`: everyone named goes in `people` (the tool finds their
Slack account even if they never wrote to you), only named people without a
Slack account go in `guest_names`, the unnamed rest is counted in `guests`,
and `note` says what it is. When a recorded visit is wrong (other people,
names instead of anonymous guests, other days) → `update-office-visit` with
the ID from `list-office-presence`; anyone on the team may fix it, don't
cancel and record it again. When it is called off or was recorded twice →
`cancel-office-visit`. Don't ask for details you don't need; a guest count is
enough.

Someone joining for weeks (a trial period, a new hire) is still recorded as a
visit, so they count as in the office on those days. When the tool says it is
a long stay, suggest that an admin adds them as office members in the office
editor.

## Who is in the office
"kto jutro w biurze?", "ile osób będzie w piątek?" → `list-office-presence`.
Answer with names grouped by status and the expected headcount; mention the
reason only when it matters (e.g. it is only a habit, or unknown).
