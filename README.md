# denken

A collection of [Agent Skills](https://agentskills.io) for coding agents, distributed with the [`skills`](https://github.com/vercel-labs/skills) CLI.

## Install

```bash
# See which skills this repository provides
npx skills add geonwoo-jeong/denken --list

# Install every skill into the current project
npx skills add geonwoo-jeong/denken --skill '*'

# Install one skill globally for Claude Code
npx skills add geonwoo-jeong/denken --skill <name> -g -a claude-code
```

## Skills

| Skill | Description |
| ----- | ----------- |
| [denken](skills/denken/SKILL.md) | Master orchestrator. Takes a task through plan → develop → independent QA → wiki, with a review loop at each stage, and delivers only approved results. |

### The DENKEN team

```text
user ⇄ DENKEN ─▶ PLAN     METHODE ⇄ RICHTER
               ─▶ DEVELOP  STARK   ⇄ RICHTER   ◀─ QA failure
               ─▶ QA       GENAU (separate agent: Claude, Codex, ...)
               ─▶ WIKI     SERIE   ⇄ RICHTER
               ─▶ DONE     approved results only
```

| Name | Role |
| ---- | ---- |
| DENKEN | Master / orchestrator: the only agent the user talks to |
| METHODE | Planning worker |
| RICHTER | Reviewer for plan, development and wiki |
| STARK | Development worker |
| GENAU | Independent QA, run as a separate agent process |
| SERIE | Wiki / knowledge worker |

## Development

Requires Node.js 20 or later. There are no dependencies to install.

```bash
npm run new -- my-skill                                  # scaffold skills/my-skill/SKILL.md
npm run validate                                         # check every skill
npx skills add . --list                                  # confirm the CLI discovers it
npx skills use ./ --skill my-skill --agent claude-code   # try it without installing
```

```text
skills/<name>/SKILL.md       one directory per skill (published)
skills/<name>/references/    optional: detail the agent loads on demand
skills/<name>/scripts/       optional: executable helpers
skills/<name>/assets/        optional: templates and static files
template/                    scaffold used by `npm run new` (not published)
scripts/                     repository tooling (not published)
```

[AGENTS.md](AGENTS.md) covers the authoring conventions.
