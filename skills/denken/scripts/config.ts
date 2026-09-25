#!/usr/bin/env node
/*
 * Which AI provider (and optionally which model and effort) plays each DENKEN role.
 *
 *   node config.ts [--json]                              show the resolved assignment
 *   node config.ts init [--local|--global]               save the current assignment as a config file
 *   node config.ts set <key> <value> [--local|--global]
 *   node config.ts unset <key> [--local|--global]
 *   node config.ts reset [--local|--global]              delete the config file
 *
 * Keys: <role>              provider: claude | codex | auto
 *                           workers: methode (plan), stark (dev), serie (wiki)
 *                           reviewers: richter (plan), ubel (dev), frieren (wiki); QA: genau
 *       <role>.model        model name passed to the provider CLI
 *       <role>.effort       reasoning effort passed to the provider CLI
 *       <role>.network      true | false: network access for the role's commands
 *                           (default: true for stark and genau, false for the others; reviewers never)
 *       providers           comma-separated list of providers DENKEN may use
 *       allowSameReviewer   true lets the same provider, model and effort check its own work
 *       limits.topicRepeats, limits.roundsPerStage, limits.callTimeoutMin, limits.parallelUnits
 *       seeds.<provider>    true | false: FLAMME keeps worker, reviewer and QA seed sessions that
 *                           every call forks (default: claude true, codex false)
 *       levels.<provider>.<light|heavy>.<model|effort>
 *                           what a level DENKEN picks for a stage means on each provider;
 *                           "standard" is always the role's own model and effort
 *
 * Files, later ones override earlier ones. Run from the project root.
 *   ~/.config/denken/config.json   --global  personal defaults for every project
 *   .denken/config.json            (default) shared with the team; commit it
 *   .denken/config.local.json      --local   personal override for this project; not committed
 */
import { configMain } from "./lib/config-cli.ts";

const ARGS_START = 2;

await configMain(process.argv.slice(ARGS_START));
