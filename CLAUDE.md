@AGENTS.md

## Claude Code specifics

- Specialist skills live in `.claude/skills/`. Invoke them with the Skill tool according to the **Delegate to specialist skills** table above. For multi-area work, start with `solutions-architect`.
- When you run specialists as subagents, load that area's skill in each one and give it the interface (types, events, error codes) the architect defined.
