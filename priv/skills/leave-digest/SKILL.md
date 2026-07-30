---
name: leave-digest
description: Daily 18:00 (Sun-Thu) digest of who has tomorrow off, with a short note on their absence where known, posted automatically to a fixed channel. Not for on-demand use via use_skill — SkillSchedulerWorker/SkillRunner triggers this autonomously and feeds you this file's body directly as instructions.
cron: "0 18 * * 0-4"
channel: "C087QF130R3"
---

# Leave digest (cron skill)

You're running on a schedule (18:00 Europe/Warsaw, Sun-Thu — so the report
covers Mon-Fri, the evening before), not replying to a message — there's no
user to ask questions or wait for. Just do this:

1. Work out tomorrow's date from the current time given in your system
   prompt.
2. Call `list_facts` with prefix `"absence:"` to get every recorded
   absence/vacation.
3. Keep only the ones whose date range (the `start..end` part before the
   ` — `) covers tomorrow's date.
4. If none cover tomorrow, reply with exactly `EMPTY` — don't post "no one is
   off tomorrow" every evening.
5. Otherwise, for each person covered, try `search_notes` with a query built
   from their name plus "urlop" (e.g. "Jan Kowalski urlop") to see if there's
   any extra context worth a one-line mention (destination, "back on X",
   etc.) beyond the bare date range. Only use it if it's clearly about the
   same absence — don't guess or invent details that aren't there.
6. CRITICAL — your reply is posted to Slack completely verbatim, character
   for character, with no cleanup on the way out. There is no separate
   "thinking" channel: whatever you write is what gets posted. This means:
   - Do NOT write any reasoning/analysis before the message, even one
     sentence of it. Banned patterns (real examples of what went wrong
     before, do not repeat this shape): "The user ID ... is ...", "the fact
     text says ... which seems like a placeholder", "No extra context found
     via notes", "Let me write the reply", "So tomorrow ... has a day off".
   - Do NOT narrate tool calls ("Posting the digest:", "I checked...").
   - Work everything out silently. Then write ONLY the final Polish
     sentence(s) described below — literally nothing before or after it.
     If you notice yourself reasoning in plain sentences, stop, discard it,
     and write only the actual message.
7. Always write in Polish, one language only, never mix in English.
8. Write like a person, not a data dump — the whole reply is ONE flowing
   paragraph (one or two sentences), never a list, never one line per
   person, no bullets/dashes and no raw `YYYY-MM-DD..YYYY-MM-DD` ranges:
   - Name everyone who's off in that same sentence, then weave in whatever
     extra context you found for each of them, right there in the sentence
     — don't break people onto separate lines just because one of them has
     more context than another.
   - Skip dates entirely for a plain single day off (it's already "jutro").
     Only mention a return date/duration for someone if you actually know
     it from the fact, phrased naturally ("wraca 5 sierpnia", "jeszcze
     przez tydzień") — never the raw range.
   - Examples of the tone to match:
     - "Jutro nie będzie Kamila i Natalii — Kamil dalej na wakacjach we
       Włoszech, a Natalia ma zwykły dzień wolny."
     - "Jutro wszyscy w pracy jak zwykle." (only if you had something to
       report at all — remember step 4 already covers the fully-silent
       case)
     - "Jutro Anna ma wolne, wraca 5 sierpnia."
