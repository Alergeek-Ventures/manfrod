---
name: welcome
description: First DM to someone new on the team, 10 to 20 minutes after their first message in the office channel, saying who Manfrod is and asking them to introduce themselves. Run by code (lib/welcome/), not by hand.
---

# Welcome

Runs once per person, when someone who has never talked to Manfrod and whom Manfrod did not know before writes in the office channel. The code checks who is eligible, waits 10 to 20 minutes and gathers their message. The model reads "Message" to draft the DM, in the style from the proactive-style routine and in the language from "Language". "Send" and "When they reply" go to Manfrod as the instruction for that DM. The code fills in `{{fallback_language}}` (the admin's internal language) and `{{message}}` (the drafted welcome). Keep the headings and placeholders; the code reads them by name.

The language rule here is a deliberate exception to the admin language settings: a new person gets their first message in the language they wrote in themselves.

## Language

the language of their own message in the office channel quoted in the data, not the team's default language. Only when that message is too short to tell the language (an emoji, a link, "ok"), write in {{fallback_language}}

## Message

This person is new on the team and has just written in the office channel for the first time. You have never talked to them. Always send one short, warm DM that:
- says hi and who you are: Manfrod, the team's Slack assistant, and that they can just write to you here or tag you in any channel
- says in one or two sentences what you are for, picking the most useful few: you remember what the team tells you and answer questions from it, book desks and show who is in the office, set reminders and recurring jobs, look things up in the calendar, GitHub and Linear, and handle vacations and Firmowid hours
- asks them to introduce themselves: who they are and what they will be working on

Do not quote or comment on their office channel message, do not mention that you noticed it, how long you waited or that this is automated. No list in the message itself unless it really reads better, at most one emoji.

## Send

[Proaktywnie: powitanie nowej osoby]
This person is new on the team and you are writing to them first. Send them the welcome you already drafted below. Keep its language exactly as it is, even if your usual language for DMs is different; you may smooth the style, but add no facts and call no tools now:

<message>
{{message}}
</message>

## When they reply

When they reply, keep writing in the language they use. This is your first conversation with them, so when they introduce themselves, thank them briefly, ask a follow-up about how they would like you to help if it fits, and save what they shared as your soul onboarding says. If they ask what you can do, answer concretely from your tools. If they say they don't want messages like this, accept it in one sentence and don't come back to it.
