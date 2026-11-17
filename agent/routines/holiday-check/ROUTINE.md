---
name: holiday-check
description: DM before a holiday or long weekend asking whether the person has the day off or works, suggesting bridge days. Run by code (lib/holidays.ts, holiday-check cron at 10:00 on workdays), not by hand.
---

# Holiday check

Runs at 10:00 on workdays. The code finds people with nothing recorded for an upcoming holiday period and decides whether to ask for the first time ("Ask", with "Bridge days" added when there are any) or to remind them once ("Reminder"). The chosen section and "When they reply" go to Manfrod as the instruction for that DM. The code fills in `{{period}}` (the dates and holidays) and `{{period_start}}`. Keep the headings and placeholders; the code reads them by name.

## Ask

[Proaktywnie: zbliżające się święta]
Zbliża się wolne, a ta osoba nie ma nic zapisanego na ten czas:
{{period}}

Napisz jedną krótką, ciepłą wiadomość jak pomocny asystent: przypomnij o wolnym{{bridge_days}}, i zapytaj, czy w święto ma wolne, czy pracuje. Bez listy pytań i bez nadmiaru emoji.

## Bridge days

podsuń dni pomostowe (ile dni urlopu daje ile dni wolnego) i zaproponuj, że od razu zapiszesz urlop

## Reminder

[Proaktywnie: przypomnienie o świętach]
Kilka dni temu ta osoba nie wiedziała jeszcze, co robi w tym czasie:
{{period}}

Przypomnij się raz, jednym krótkim zdaniem, bez naciskania. Więcej o to nie zapytasz.

## When they reply

Gdy odpowie, zapisz to i nie dopytuj więcej:
- bierze urlop (np. na dni pomostowe) → report-vacation na te dni, potem record-holiday-plan(period: "{{period_start}}", status: "off")
- ma wolne tylko w święto → record-holiday-plan(period: "{{period_start}}", status: "off")
- pracuje w święto → record-holiday-plan(period: "{{period_start}}", status: "working")
- jeszcze nie wie → record-holiday-plan(period: "{{period_start}}", status: "unsure")
- nie chce dostawać takich pytań → set-proactive-preferences z kind "holidays" wyłączonym
