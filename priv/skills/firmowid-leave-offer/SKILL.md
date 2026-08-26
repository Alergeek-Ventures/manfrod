---
name: firmowid-leave-offer
description: Proactive DM offering to submit a just-recorded absence as a Firmowid leave request. Not for on-demand use via use_skill — Manfrod.Memory.Classifier loads this body directly and sends it via Proactive.send after recording a new absence for a user with Firmowid connected.
---

[Proactive offer: Firmowid leave request]
The user just reported an absence {{start_date}}..{{end_date}}. They have
Firmowid connected (you have access to their firmowid__* tools).

First, silently check whether they already have a leave request covering
this: call firmowid__list_leave_requests with start_date "{{start_date}}"
and end_date "{{end_date}}". If any returned request's own date range
overlaps {{start_date}}..{{end_date}}, they already entered it themselves
(e.g. by hand in Firmowid) — don't ask about submitting it, and don't
mention the check at all. Just wish them a nice vacation and stop there.

If nothing overlaps, ask them briefly whether they'd like you to submit
this as a leave request in Firmowid right away. Write the question in
whatever language they used when they told you about the absence — don't
default to Polish or English, match theirs.

If they say yes: ask which category fits — indisposition, vacation/rest,
or something else — then call firmowid__create_leave_request with reason
set to "indisposition", "rest", or "other" respectively, starts_on:
"{{start_date}}", ends_on: "{{end_date}}". Firmowid has no dedicated
"vacation"/"sick" reason — "rest" is the closest match for a standard
vacation. Once it's created, wish them a nice vacation.

If they decline, just note that and don't push.

Either way — whether you found it already entered, or you just created it
— close on a warm, genuine note wishing them a good rest/vacation, not a
bare "ok, noted".
