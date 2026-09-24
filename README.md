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
| [denken](skills/denken/SKILL.md) | Master orchestrator. Agrees a spec with you, has TODO lists written and confirmed, then builds, verifies and documents the work. Each stage is reviewed read-only by a different AI, and only approved results are delivered. |

### The DENKEN team

```text
spec    DENKEN ⇄ you          spec.md: in scope (S1..), out of scope (X1..)
plan    METHODE ⇄ RICHTER     todo-dev.md (D1..), todo-qa.md (Q1..)
        you confirm the scope and both TODO lists
dev     STARK ⇄ UBEL          item by item: build, unit test, tick off (todo-dev.md only)
qa      GENAU                 runs todo-qa.md; a failure goes back to dev
wiki    SERIE ⇄ FRIEREN
done    approved results only
```

| Name | Role | Default provider |
| ---- | ---- | ---------------- |
| DENKEN | Orchestrator. The only agent you talk to; asks what it needs and writes the spec | the agent you run it in |
| METHODE | Planning worker: turns the spec into a development TODO and a QA TODO | Claude |
| STARK | Development worker: builds the development TODO item by item (build, unit test, tick off) | Codex |
| SERIE | Wiki / knowledge worker | Claude |
| RICHTER | Planning reviewer: checks the TODO lists against the spec, read-only | the other provider from METHODE |
| UBEL | Development reviewer: checks code, TODO status and change scope against the plan, read-only | the other provider from STARK |
| FRIEREN | Wiki reviewer: checks the docs against the code and the spec, read-only | the other provider from SERIE |
| GENAU | Independent QA: runs the QA TODO against the product | the other provider from STARK |

How it works:

- **Separation:** every worker, reviewer and QA call is a separate `claude -p` or `codex exec` process, started by a deterministic run engine (`skills/denken/scripts/denken.mjs`). The DENKEN agent writes the spec with you, rules on disputes and reports back.
- **Read-only review:** reviewers are read-only. Claude gets only Read, Grep and Glob; Codex runs in its read-only sandbox. A review that changes a file is rejected.
- **Approval gate:** a stage moves on only after its review has no blocking findings. The engine also checks that the TODO lists cover every in-scope item and nothing out of scope, and development waits for you to confirm them.
- **Escalation:** DENKEN is called in when the same topic is raised 3 times, when progress stalls, or when a stage reaches 5 rounds.
- **Single provider:** with only Claude or only Codex installed, everything runs on that provider.

### Choosing which AI plays each role

Requires the [Claude Code](https://code.claude.com) and/or [Codex](https://developers.openai.com/codex) CLI, installed and logged in. The first time DENKEN runs in a project, it proposes an assignment and asks you to confirm it. You can change it at any time, either by asking DENKEN ("configure denken") or directly:

```bash
S=.claude/skills/denken/scripts        # or wherever the skill was installed, e.g. .agents/skills/denken
node $S/config.mjs                     # show the assignment and provider status
node $S/config.mjs set stark claude    # Claude develops; its reviewer and QA switch to Codex
node $S/config.mjs set stark.model <model> --local
```

`.denken/config.json` is shared with your team. `.denken/config.local.json` (`--local`) and `~/.config/denken/config.json` (`--global`) hold personal overrides.

## Development

Requires Node.js 20 or later. There are no dependencies to install.

```bash
npm run new -- my-skill                                  # scaffold skills/my-skill/SKILL.md
npm run validate                                         # check every skill
npm test                                                 # run-engine tests (fake agent CLIs, no API calls)
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
tests/                       tests for skill scripts (not published)
```

[AGENTS.md](AGENTS.md) covers the authoring conventions.
