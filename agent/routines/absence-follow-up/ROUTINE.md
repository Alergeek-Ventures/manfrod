---
name: absence-follow-up
description: DM right after someone reports an upcoming absence, offering the leave request, desk cancellations and notes that apply. Run by code (lib/nudges/absence.ts, absence follow-up events), not by hand.
---

# Absence follow-up

Runs when someone has just told Manfrod about an upcoming absence and Manfrod confirmed it. The code gathers the data (Slack, memory, calendars, Firmowid, GitHub) and decides who gets it; the model reads "Message" to decide whether to send and to draft it, in the style from the proactive-style routine. "When they reply" goes to Manfrod together with the sent message, for the conversation that follows. Keep both headings; the code reads them by name.

## Message

This person just told you about an upcoming absence and you have already confirmed it. Offer, in one message, only the follow-ups that apply. When their Firmowid leave requests are listed and none covers these dates, always send and open by asking whether to submit the leave request to Firmowid now, with the dates and the type you would pick filled in: "rest" for vacation or a day off, "indisposition" for feeling unwell, "other" with a short note for anything else. Firmowid can't take sick leave (L4) or unpaid leave this way, so for those say they need to file it in Firmowid themselves. Then mention, briefly, the other follow-ups that apply: cancelling their desk bookings on those days, a short note in their project channels, and meetings that clash (name them and suggest letting attendees know). If a holiday sits right next to it, you may point out the long break. End warmly. If nothing applies, do not send.

## When they reply

Gdy odpowie:
- wniosek urlopowy: najpierw sprawdź firmowid__list_leave_requests dla tych dat i jeśli jakiś wniosek już je pokrywa, nie twórz drugiego, tylko o tym powiedz. Inaczej wywołaj firmowid__create_leave_request ze starts_on i ends_on z danych, reason "rest", "indisposition" albo "other" (ten, który zaproponowałeś, chyba że poprawi) i krótkim note. L4 ani urlopu bezpłatnego nie da się tak zgłosić, wtedy powiedz, że trzeba to zrobić w Firmowidzie
- biurka: cancel-desk-reservation dla każdego dnia
- kanały projektów: napisz krótką notkę i wyślij ją przez announce-absence do kanałów, które wybierze
- jeśli czegoś nie chce, przyjmij to i nie wracaj do tego
