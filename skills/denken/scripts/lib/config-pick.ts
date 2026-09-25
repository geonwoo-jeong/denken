/*
 * Picking each role's agent. A worker gets its configured provider or the default; a reviewer (and
 * GENAU) gets a provider other than the worker whose work it checks when there is one. Reviewers
 * never get network access: they are read-only and run nothing that needs it.
 */
import type { Agent, Provider, StageAgents } from "./types-config.ts";
import { EMPTY, hasKey, textOf } from "./json.ts";
import type { Notes, PickRequest, Picked, ProviderContext } from "./types-partc.ts";
import { SUPPORTED, isProvider } from "./config-defaults.ts";
import type { JsonObject } from "./types-json.ts";
import type { TextMap } from "./types-names.ts";
import { shown } from "./config-layers.ts";

interface PickedStages extends Notes {
  readonly stages: StageAgents;
}

const REVIEWERS: ReadonlySet<string> = new Set(["richter", "ubel", "frieren"]),
  otherProvider = (context: ProviderContext, request: PickRequest): Provider => {
    if (request.avoid) {
      return context.usable.find((provider) => provider !== request.avoid) ?? request.avoid;
    }
    return request.fallback;
  },
  wantedOf = (spec: JsonObject): string => {
    const { provider } = spec;
    if (!hasKey(spec, "provider") || provider === null) {
      return "auto";
    }
    return shown(provider);
  },
  networkOf = (request: PickRequest): boolean => {
    const { network } = request.spec;
    if (REVIEWERS.has(request.label)) {
      return false;
    }
    if (typeof network === "boolean") {
      return network;
    }
    return request.networkDefault;
  },
  agentOf = (request: PickRequest, provider: Provider): Agent => ({
    effort: textOf(request.spec, "effort"),
    level: "standard",
    model: textOf(request.spec, "model"),
    network: networkOf(request),
    provider,
  }),
  whyUnusable = (context: ProviderContext, provider: Provider): string => {
    if (!context.allowed.includes(provider)) {
      return "not in providers";
    }
    return context.status[provider].problem;
  },
  pick = (context: ProviderContext, request: PickRequest): Picked => {
    const other = otherProvider(context, request),
      wanted = wantedOf(request.spec);
    if (wanted === "auto") {
      return { agent: agentOf(request, other), errors: [], warnings: [] };
    }
    if (!isProvider(wanted)) {
      return { agent: agentOf(request, other), errors: [`${request.label} is "${wanted}" (use ${SUPPORTED.join(", ")} or auto)`], warnings: [] };
    }
    if (!context.usable.includes(wanted)) {
      return { agent: agentOf(request, other), errors: [], warnings: [`${request.label} is set to ${wanted}, which is ${whyUnusable(context, wanted)} here; using ${other} instead`] };
    }
    return { agent: agentOf(request, wanted), errors: [], warnings: [] };
  },
  notesOf = (picks: readonly Picked[]): Notes => ({ errors: picks.flatMap((picked) => picked.errors), warnings: picks.flatMap((picked) => picked.warnings) }),
  // Each stage's worker, then its reviewer, avoiding the worker's provider; GENAU avoids STARK's.
  pickStages = (context: ProviderContext, specs: TextMap<JsonObject>): PickedStages => {
    const [first = "claude", second = first] = context.usable,
      role = (label: PickRequest["label"], fallback: Provider, avoid: Provider | ""): PickRequest => ({ avoid, fallback, label, networkDefault: label === "stark" || label === "genau", spec: specs[label] ?? EMPTY }),
      methode = pick(context, role("methode", first, "")),
      richter = pick(context, role("richter", first, methode.agent.provider)),
      stark = pick(context, role("stark", second, "")),
      ubel = pick(context, role("ubel", first, stark.agent.provider)),
      serie = pick(context, role("serie", first, "")),
      frieren = pick(context, role("frieren", first, serie.agent.provider)),
      genau = pick(context, role("genau", first, stark.agent.provider)),
      notes = notesOf([methode, richter, stark, ubel, serie, frieren, genau]);
    return {
      errors: notes.errors,
      stages: {
        dev: { reviewer: ubel.agent, worker: stark.agent },
        plan: { reviewer: richter.agent, worker: methode.agent },
        qa: { runner: genau.agent },
        wiki: { reviewer: frieren.agent, worker: serie.agent },
      },
      warnings: notes.warnings,
    };
  };

export { pickStages };
