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

Add `cron` (and `channel`, unless `scope: user` — see below) to the
frontmatter to make a skill run on a schedule instead of (or in addition
to) on-demand:

```yaml
cron: "0 18 * * *"      # standard 5-field cron, evaluated in Europe/Warsaw
channel: "C0BFLHF7TQ8"  # Slack channel ID the run posts to
```

`Manfrod.Workers.SkillSchedulerWorker` (hourly) schedules a
`Manfrod.SkillRunner` job for every future cron firing in the next 12h.
When it fires, **the skill's body becomes the full instructions for a real
autonomous agent turn** — same tools, same reasoning, as if a user had typed
the request. It is not a hardcoded dispatch by skill name; there's no code
to write per skill. Just describe what should happen in plain language,
including that there's no user to ask questions of — the skill should be
fully self-directed (see `leave-digest/SKILL.md` or `holiday-check/SKILL.md`
for examples).

If the instructions say there's nothing worth posting in some case, reply
with exactly the single word `EMPTY` — that's caught and silently discarded
instead of being posted.

To test a cron skill without waiting for its real schedule, temporarily set
`cron` to something a minute or two out (e.g. `"* * * * *"`) and watch it
fire, or manually insert a job:

```elixir
Manfrod.Workers.SkillTriggerWorker.new(%{skill_name: "my-skill"}) |> Oban.insert()
```

### Random time-of-day: `RAND(HH:MM-HH:MM)`

For a job that shouldn't fire at the exact same minute every day (e.g. so
it doesn't look like everyone gets pinged in lockstep), replace the
minute+hour fields with `RAND(HH:MM-HH:MM)`, keeping the remaining 3 fields
(day-of-month, month, day-of-week) as standard cron:

```yaml
cron: "RAND(19:00-20:00) * * 1-5"   # one random instant in 19:00-20:00, Mon-Fri
```

The random instant is drawn once, the first time `SkillSchedulerWorker`
sees that day's window is open, and then frozen — later scheduler runs
that same day won't re-roll or duplicate it (see
`Manfrod.Workers.SkillSchedulerWorker` moduledoc for how the Oban
uniqueness key makes that safe).

### Per-user skills: `scope: user` + `requires_mcp`

By default a cron skill is one global run (as a synthetic system user)
posting to a fixed `channel`. Add `scope: user` and `requires_mcp: "<mcp
provider id>"` to instead run the skill **once per user connected to that
MCP provider**, each on their own randomly-drawn time if the cron uses
`RAND(...)`, scoped to that real user (their own tools, including that MCP
provider's) and posting the final reply to their Slack DM instead of a
channel:

```yaml
cron: "RAND(19:00-20:00) * * 1-5"
scope: user
requires_mcp: firmowid
```

See `firmowid-session-check/SKILL.md` for a full example.

## Removing a skill

Delete the folder. That's it.
