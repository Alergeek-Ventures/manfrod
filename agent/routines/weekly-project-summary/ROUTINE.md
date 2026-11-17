---
name: weekly-project-summary
description: Friday post in each internal project channel summing up the project's week. Run by code (lib/nudges/projects.ts, nudges-project-summaries cron at 15:00 on Fridays), not by hand.
---

# Weekly project summary

Runs at 15:00 on Fridays for every internal project channel that has it switched on. The code gathers the channel's messages, memory notes, Linear issues and GitHub work of the week; the model reads "Message" to decide whether to post and to draft it. Nobody replies to it, so there is no follow-up section. Keep the heading; the code reads it by name.

## Message

It is Friday afternoon. Write this project's weekly summary for its Slack channel, based only on the data below.

What goes in:
- Only what happened this week: work finished, decisions made, what is in progress or blocked, and what is planned for next week. People often repeat the status of older work; list as done only what you can tell was finished this week.
- Only this project. Notes and messages about other projects or products end up here too, e.g. a wish about another app posted in this channel; leave them out.
- GitHub commits and pull requests from the project's repositories show the code work: a pull request merged this week is done, an open one is in progress. Summarize what the work achieved rather than listing commits, and mention a pull request as a Markdown link titled repo#number.
- The channel messages are the most reliable source. Linear issues are listed only when the team keeps Linear up to date; when one disagrees with what people wrote, trust the messages and leave the issue out, and never list backlog issues nobody worked on.
- Leave out small talk, gossip, private remarks, access and account chores, and anything already obsolete.
- Credit people with <@SLACK_ID> where it helps. Refer to a Linear issue by its identifier, e.g. ABC-12; it becomes a link on its own.
- Don't promise anything for later; nobody will act on this message.

Format, in Markdown: a bold title line naming the week, then short sections, each a bold label on its own line (done, in progress or blocked, next week, decisions when there were any) followed by "- " bullets of one line each. Skip empty sections and keep it under about ten bullets. If the week was quiet and there is nothing meaningful to report, do not send.
