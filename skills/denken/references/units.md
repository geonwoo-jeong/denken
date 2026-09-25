# Parallel units

Read this when a request has parts that can be built at the same time, or when a `next` action carries a `unit`.

A run can split its request into units. Each unit goes through planning (METHODE ⇄ RICHTER), development (STARK ⇄ UBEL) and independent QA (GENAU) in its own git worktree, at the same time as the others. When every unit is done, the engine merges them into the project. UBEL then reviews the merged change, GENAU verifies it again, and SERIE ⇄ FRIEREN document it once.

## When to split

Split only work that is independent in both of these ways:

- **Scope:** no two units change the same file or folder. The engine refuses a split whose scopes overlap.
- **Dependencies:** no unit needs another unit's result, such as a function, a type, an API or a migration, to be built or tested.

Everything that overlaps goes in one unit, where its DEV items run in order. A dependency the engine cannot see still breaks a split, so judge it before you split. When in doubt, don't split.

Files that many changes touch keep their work together, because they make a split overlap:

- `package.json` and lock files;
- route or plugin registries and barrel `index` files;
- shared config and generated files.

A change to dependencies cannot be split at all: every unit shares the project's installed dependencies.

## units.md

Write it in the run directory, next to `request.md`, and show it to the user with the request:

```markdown
# Units

- UNIT-1 (REQ-001, REQ-002) Card height. Scope: `src/quickviz/`, `test/quickviz/`.
- UNIT-2 (REQ-003) CSV export. Scope: `src/export/`, `test/export/`.
```

A unit's line can add its own levels, which override the run's for that unit: `- UNIT-1 (REQ-001) Card height. Scope: \`src/quickviz/\`. Levels: dev=heavy.`

`start` refuses the split unless it follows these rules:

- Units are numbered UNIT-1, UNIT-2, … in order, at most 9 of them.
- Every REQ item is in exactly one unit.
- Each unit has a title and a scope. A scope is the paths the unit may change: folders (`src/a/`) or files, with no globs.
- No two scopes overlap.

Without `units.md`, the request runs as one, as usual.

## What the engine does

- **Worktrees:** it records the project as it is, uncommitted and untracked files included, as a commit. It then starts one worktree per unit from that commit, under `~/.cache/denken/worktrees/`. The project needs at least one commit.
- **Shared dependencies:** the project's `node_modules`, when git ignores it, is linked one folder above the worktrees. Module resolution finds it there and git does not see it.
- **Each unit's run:**
  - Its request.md is generated: the unit's REQ items, all of OUT, LATER and CAUTION, and a `## Unit` section. That section gives the scope, the unit's numbers (DEV-101, QA-101 for UNIT-1; DEV-201 for UNIT-2) and the units built beside it.
  - Planning items outside the unit's numbers or scope, and changed files outside its scope, go straight back to the worker.
  - Claude agents in a unit are denied edits to the project itself.
- **Parallel limit:** at most `limits.parallelUnits` units work at once (default 3). A unit that waits on you or on the user frees its place.
- **Record:** one record for the run. Each unit's steps go in their own folders (`01-planning/UNIT-1/`, `03-qa/UNIT-1/qa-1/`, `raw/UNIT-1/`). The timeline and `verdicts.md` show each unit's lines with its name.
- **Merge:** when every unit is done, the engine applies all the units' changes together in an integration worktree. Only if they all apply does it apply the combined change to the project, so the project is never half merged.
  - The merged `todo-dev.md` holds every unit's DEV items, as ticked, with their evidence.
  - The merged `todo-qa.md` starts with QA-001, "the project's whole test suite passes on the merged result", followed by every unit's checks, unticked, to be verified again.
- **After the merge:** the project continues as a normal run:
  - UBEL reviews the merged change for what no unit's reviewer could see: duplicated helpers, inconsistent names or APIs, conflicting assumptions.
  - GENAU runs every check again on the merged product.
  - A failure goes through the usual recovery loop, in the project.
  - Then the docs.
- The worktrees are removed after the merge. After an abort they are kept, and the `aborted` action lists them.

## Acting on a unit

When a unit needs you, `next` returns its action with `unit` set (for example `needs_ruling` for UNIT-2). Answer it on the run with `--unit`:

```bash
node <skill-dir>/scripts/denken.mjs rule <run> --unit UNIT-2 --decision dismiss --note "..."
node <skill-dir>/scripts/denken.mjs grant <run> --unit UNIT-1 --dir <path> --note "..."
node <skill-dir>/scripts/denken.mjs retry <run> --unit UNIT-1
node <skill-dir>/scripts/denken.mjs status <run> --unit UNIT-1
```

The other units keep working while you decide, but only while `next` runs, so run `next` again once you have answered.

## Confirmation

The first confirmation covers every unit at once. When every unit's plan has passed its review, `next` returns `needs_user` with `reason: confirm_todos` and a `units` list: each unit's files and open questions. Show the user `units.md` and each unit's request.md and TODO lists. Then do one of these:

- **Approve:** `confirm <run> --user-said "<their approval, verbatim>"` confirms every unit.
- **Change one unit's lists:** `rule <run> --unit UNIT-n --decision replan --note "<the change>"`. Open questions work the same way, per unit.
- **Change the split itself:** edit `units.md` (and `request.md`), then `rule <run> --decision replan --note "<why>"`. This is possible only while every unit waits for this first confirmation. The units are stopped, and new worktrees start from the new split.

After the first confirmation, a unit that replans is confirmed on its own, with `confirm <run> --unit UNIT-n --user-said "..."`.

## Stops

| `needs_user` reason | Meaning |
| --- | --- |
| `main_tree_changed` | The project changed while units worked, and they are merged into it. `status` lists the changed files. When the project is as it should be, run `retry <run>`; the engine then merges into the project as it is. |
| `merge_conflict` | The units' changes did not apply together (`unit`, `patch`, `error`). This means a split whose work overlapped after all. Run `retry <run>` once the cause is fixed, or `rule <run> --decision abort`. |
| `unit_aborted` | A unit was aborted, so the units cannot be merged. Ask the user, then `rule <run> --decision abort` (or `replan` before the first confirmation). |

`rule <run> --decision abort` stops every unit at any time.

## Summary

In `summary.md`, report each unit: its REQ items and scope, its rounds, and its QA result. Then report the merge, the review of the merged change, and the QA after the merge.
