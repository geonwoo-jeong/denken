# AGENTS.md

This repository publishes [Agent Skills](https://agentskills.io). Each skill lives in `skills/<name>/` and users install it with the [`skills`](https://github.com/vercel-labs/skills) CLI (`npx skills add geonwoo-jeong/denken`).

## Commands

- `npm run new -- <name>`: scaffold `skills/<name>/SKILL.md` from `template/SKILL.template.md`
- `npm run validate`: spec and convention checks for every skill. Run it before you call a change done.
- `npx skills add . --list`: confirm the CLI discovers the skill
- `npx skills use ./ --skill <name> --agent claude-code`: try a skill in a fresh agent session without installing it

## Repository rules

- One skill per directory under `skills/`. The directory name must equal the frontmatter `name`.
- Only files named `SKILL.md` under `skills/` should exist. If `skills/` has no skills, or someone installs with `--full-depth`, the CLI scans the whole repo and publishes any `SKILL.md` it finds. That is why the template is named `SKILL.template.md`.
- Treat `.agents/skills/`, `.claude/skills/` and other agent directories as installed third-party skills. They are tracked by `skills-lock.json` and are not sources.
- When you add, rename or remove a skill, update the Skills table in `README.md`.

## Writing a skill

### Frontmatter

- `name`: lowercase letters, digits and single hyphens, at most 64 chars. Name the capability (`release-notes`, `reviewing-migrations`), not the implementation.
- `description`: at most 1024 chars, written in the third person. Say what the skill does **and** when to use it. The agent reads only this text when it decides whether to load the skill, so include the phrases users actually say. If a nearby skill could be confused with this one, say what this one is not for.
- Quote the value when it contains `: ` or `#`. Otherwise YAML parsing fails and the CLI skips the skill at install time.
- Optional fields: `license`, `compatibility` (at most 500 chars), `metadata`, `allowed-tools`. Set `metadata.internal: true` to hide a work-in-progress skill from discovery.

### Body

- Write for a capable model. Add only what it would not already know: project conventions, domain facts, sharp edges, and the order of operations.
- Give the reason behind a rule instead of emphasizing it. Current models follow instructions literally, and stacks of ALL-CAPS or MUST/NEVER lead them to over-apply rules. Keep hard constraints for actions that are actually destructive.
- Match specificity to fragility. Give exact commands for fragile, order-dependent steps. Give goals and acceptance criteria for judgment calls.
- End with a way to check the work: a checklist, a command to run, or an observable result.
- Keep `SKILL.md` under about 500 lines. Move detail into `references/<topic>.md`, link each file directly from `SKILL.md` (one level deep), and say when to read it.
- Put deterministic or repetitive work in `scripts/`. Tell the agent to run those scripts, not read them, and make them print actionable errors.
- One concrete input/output example teaches more than a paragraph of description.
- Use relative paths with forward slashes. Avoid statements that go stale, such as "the latest version is X".

### Testing

1. Before you write the skill, list at least 3 realistic prompts that should trigger it and 1 or 2 that should not.
2. After you write it, run those prompts in a fresh session with `npx skills use`. Check that the skill triggers, that the agent follows it, and that the result meets the skill's completion criteria.
3. If the skill triggers when it shouldn't, or fails to trigger when it should, fix the `description` first.
