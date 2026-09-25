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
| [denken](skills/denken/SKILL.md) | Master orchestrator. Writes a request with you, can split it into units built in parallel, has TODO lists written and confirmed, then builds, verifies and documents the work. Each stage is reviewed read-only by a different AI, and only approved results are delivered. |

### The DENKEN team

```text
request DENKEN ⇄ you          request.md: goal, confirmed (REQ-001..), out of scope (OUT-..),
                              not now (LATER-..), cautions (CAUTION-..)
plan    METHODE ⇄ RICHTER     todo-dev.md (DEV-001..), todo-qa.md (QA-001..)
        you confirm the request and both TODO lists
dev     STARK ⇄ UBEL          item by item: build, unit test, tick off with evidence (todo-dev.md only)
qa      GENAU                 runs todo-qa.md and saves evidence
          fail → recovery TODO (todo-fix.md, FIX-001..) → STARK fixes → UBEL approves → QA again
wiki    SERIE ⇄ FRIEREN       only the docs affected by the files this run changed
done    approved results only; the whole run is recorded in ai-log/

units   optional: independent parts of a request run plan, dev and qa in parallel, each in its
        own git worktree; then merge → review of the merged change → QA again → wiki
```

| Name | Role | Default provider |
| ---- | ---- | ---------------- |
| DENKEN | Orchestrator. The only agent you talk to; asks what it needs and writes `request.md` | the agent you run it in |
| METHODE | Planning worker: turns the request into a development TODO and a QA TODO; the only one who words TODO items | Claude |
| STARK | Development worker: builds the development TODO item by item (build, unit test, tick off with evidence) | Codex |
| SERIE | Wiki / knowledge worker | Claude |
| RICHTER | Planning reviewer: checks the TODO lists against the request, read-only | the other provider from METHODE |
| UBEL | Development reviewer: checks code, TODO status and change scope against the plan, read-only | the other provider from STARK |
| FRIEREN | Wiki reviewer: checks the docs against the code and the request, read-only | the other provider from SERIE |
| GENAU | Independent QA: runs the QA TODO against the product | the other provider from STARK |
| FLAMME | Seed AI: gets to know the project first; worker, reviewer and QA calls fork its seeds | runs as the calls that fork it |

How it works:

- **Separation:** every worker, reviewer and QA call is a separate `claude -p` or `codex exec` process, started by a deterministic run engine (`skills/denken/scripts/denken.ts`). The DENKEN agent writes the request with you, rules on disputes and reports back.
- **Read-only review:** reviewers are read-only. Claude gets only Read, Grep and Glob; Codex runs in its read-only sandbox. A review that changes a file is rejected.
- **Approval gate:** a stage moves on only after its review has no blocking findings. The engine also checks that the TODO lists cover every confirmed item and nothing out of scope or deferred, and development waits for you to confirm them.
- **TODO lists:** only METHODE words the items, and only STARK ticks development items. No tick without evidence: STARK ticks an item through the engine, which runs its tests, checks that the evidence names a file changed for the item, and writes the tick and evidence into the list:

  ```markdown
  - [x] DEV-002 (REQ-002) Card height defaults to 520px, adjustable from 320 to 1,600px. Files: QuickVizLocalPage.tsx.
    Evidence: added normalHeightPx to QuickVizLocalPage.tsx, kept separate from the fullscreen height
  ```

- **Parallel units:** DENKEN can split a request into units that touch different files and don't depend on each other (`units.md`). Each unit is planned, built, reviewed and verified in its own git worktree, at the same time as the others (up to `limits.parallelUnits`). When all are done, they are merged all or none, and the merged change is reviewed and verified again. Work that overlaps in scope or depends on other work is not split; it runs in order within one unit.
- **Seeds (FLAMME):** FLAMME gets to know the project first (layout, conventions, wiki, plan) and keeps it as a worker seed, a reviewer seed and a QA seed. Every call forks its kind's seed and is then thrown away, so calls start clean, and on Claude they read the seed from the prompt cache. Codex caches per session, so seeding is off there by default.
- **Sessions:** a worker's later rounds in a stage continue its own session (up to three rounds), keeping what it did and its cache; reviewers and QA always start fresh, so no check is anchored to its last verdict.
- **Levels:** DENKEN picks a level per stage (`light`, `standard`, `heavy`) by how hard the work is, to save tokens. Workers can go light for simple work; checkers never run below standard or below the worker they check. What each level means per provider is configurable (`levels.<provider>.<level>.<model|effort>`), and `status` shows tokens and cache use per role.
- **Escalation:** DENKEN is called in when the same topic is raised 3 times, when progress stalls, or when a stage reaches 5 rounds.
- **Permissions:** workers run with least privilege. One that needs more (network, a directory outside the project, a blocked command) asks through the engine and stops; DENKEN grants the minimum or denies it, and anything broad (all network, a directory outside the project) needs your explicit answer. Agent configuration (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json`) and DENKEN's own files cannot be changed by any agent.
- **Record:** every run is written to `ai-log/<date>/<NNN>_<time>_<name>/` as it goes: `00-request`, `01-planning`, `02-development`, `03-qa` (with evidence), `04-wiki`, `raw/` (every exchange), `timeline.md` (every step, verdict, stop and resume) and `verdicts.md` (every submission and verdict exchanged, READY, REJECTED, APPROVED, PASSED, in the words it was given). Raw exchanges and QA evidence are git-ignored by default, and a secret scan runs before DONE.
- **Single provider:** with only Claude or only Codex installed, everything runs on that provider.

### Choosing which AI plays each role

Requires Node.js 22.18 or later, git, and the [Claude Code](https://code.claude.com) and/or [Codex](https://developers.openai.com/codex) CLI, installed and logged in. The first time DENKEN runs in a project, it proposes an assignment and asks you to confirm it. You can change it at any time, either by asking DENKEN ("configure denken") or directly:

```bash
S=.claude/skills/denken/scripts        # or wherever the skill was installed, e.g. .agents/skills/denken
node $S/config.ts                     # show the assignment and provider status
node $S/config.ts set stark claude    # Claude develops; its reviewer and QA switch to Codex
node $S/config.ts set stark.model <model> --local
```

`.denken/config.json` is shared with your team. `.denken/config.local.json` (`--local`) and `~/.config/denken/config.json` (`--global`) hold personal overrides.

## Development

Requires Node.js 22.18 or later: the scripts are TypeScript, which Node runs directly. The skill needs no dependencies; `npm install` brings the linter and TypeScript for development.

```bash
npm run new -- my-skill                                  # scaffold skills/my-skill/SKILL.md
npm run validate                                         # check every skill
npm run lint                                             # oxlint, every stable rule category, type-aware
npm run typecheck                                        # TypeScript, strictest settings
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
