# Adding a skill

A skill is a folder containing `SKILL.md`. Nothing else to wire up —
`Manfrod.Skills` lists `priv/skills/*/SKILL.md` from disk on every call, so a
new folder is live for the next agent turn with no recompile or deploy.

## Minimal skill

```
priv/skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: One sentence on what this is for and when to use it. This is
  always visible to the agent in its system prompt, even before the skill
  is loaded — write it for that.
---

Full instructions go here. Only loaded into context when the agent calls
`use_skill(name)` because it judged the description relevant.
```

- `name` and `description` are the only required frontmatter fields.
- The body can be as long/detailed as needed — it's not loaded until requested.
- Reference existing tool names in the body when relevant (e.g. "call
  `reserve_desk`") so the agent knows what to do, not just what the skill covers.

## Cron skills (scheduled, autonomous)

Add `cron` (and `channel`) to the frontmatter to make a skill run on a
schedule instead of (or in addition to) on-demand:

```yaml
cron: "0 18 * * *"      # standard 5-field cron, evaluated in Europe/Warsaw
channel: "C0BFLHF7TQ8"  # Slack channel ID the run posts to
```

`Manfrod.Workers.SkillSchedulerWorker` (hourly) schedules a
`Manfrod.SkillRunner` job for every future cron firing in the next 48h.
When it fires, **the skill's body becomes the full instructions for a real
autonomous agent turn** — same tools, same reasoning, as if a user had typed
the request. It is not a hardcoded dispatch by skill name; there's no code
to write per skill. Just describe what should happen in plain language,
including that there's no user to ask questions of — the skill should be
fully self-directed (see `desk-digest/SKILL.md` for an example).

To test a cron skill without waiting for its real schedule, temporarily set
`cron` to something a minute or two out (e.g. `"* * * * *"`) and watch it
fire, or manually insert a job:

```elixir
Manfrod.Workers.SkillTriggerWorker.new(%{skill_name: "my-skill"}) |> Oban.insert()
```

## Removing a skill

Delete the folder. That's it.
