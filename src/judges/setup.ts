import { existsSync, readFileSync } from "node:fs";
import { EgressGate } from "../models/egress.ts";
import type { ModelProvider } from "../models/provider.ts";
import type { JudgmentEntry } from "../store/store.ts";
import { ChainJudge, ShadowJudge } from "./compose.ts";
import { LlmJudge } from "./judge.ts";
import type { Judge } from "./judge.ts";
import { SystemOneJudge } from "./systemone.ts";
import type { SystemOneEndpoint } from "./systemone.ts";
import { laneModel } from "../training/lanes.ts";

type Env = Record<string, string | undefined>;

export const JUDGE_BACKENDS = ["llm", "typed", "jev"] as const;
type Backend = (typeof JUDGE_BACKENDS)[number];

export interface JudgeSetup {
  judge: Judge | null;
  /** Backends whose answers are used, in the order they are tried. */
  acting: Backend[];
  /** Backends asked the same questions only so their answers are logged beside the used one. */
  shadow: Backend[];
  /** What was skipped or moved, and why, for the startup log. */
  notes: string[];
}

export interface JudgeSetupDeps {
  provider: ModelProvider | null;
  log: (entry: JudgmentEntry) => void;
  fetch?: typeof fetch;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Self-hosted typed-decision servers: JUHANDU_TYPED_URLS is a comma separated list of base URLs. */
function typedEndpoints(env: Env): SystemOneEndpoint[] {
  const model = env["JUHANDU_TYPED_MODEL"] ?? "default";
  return list(env["JUHANDU_TYPED_URLS"]).map((baseUrl, i) => ({ name: `typed-${i + 1}`, baseUrl, model, local: true }));
}

function jevKey(env: Env): string | undefined {
  const direct = env["JUHANDU_JEV_KEY"] ?? env["TYPESAFE_API_KEY"] ?? env["JEV_API_KEY"];
  if (direct) return direct;
  const file = env["JUHANDU_JEV_KEY_FILE"];
  return file && existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}

/** Builds the judge from the environment. JUHANDU_JUDGE is the ordered list of backends whose answers are used (llm, typed, jev; default llm when a chat model is available), and JUHANDU_JUDGE_SHADOW lists backends that are asked the same questions only to log their answers. A self-hosted typed-decision server is not assumed to be calibrated, so it is moved to the shadow list unless JUHANDU_TYPED_ACTS=1. */
export function buildJudge(env: Env, deps: JudgeSetupDeps): JudgeSetup {
  const notes: string[] = [];
  const gate = new EgressGate(list(env["JUHANDU_PRIVATE_ALLOW"]));
  const fetchOption = deps.fetch ? { fetch: deps.fetch } : {};
  const requested = list(env["JUHANDU_JUDGE"] ?? (deps.provider?.capabilities.chat ? "llm" : ""));
  const shadowRequested = list(env["JUHANDU_JUDGE_SHADOW"]);
  const unknown = [...requested, ...shadowRequested].filter((b) => !(JUDGE_BACKENDS as readonly string[]).includes(b));
  if (unknown.length) notes.push(`Unknown judge backend ignored: ${[...new Set(unknown)].join(", ")}`);

  const acting = requested.filter((b): b is Backend => (JUDGE_BACKENDS as readonly string[]).includes(b));
  const shadow = shadowRequested.filter((b): b is Backend => (JUDGE_BACKENDS as readonly string[]).includes(b));
  if (acting.includes("typed") && env["JUHANDU_TYPED_ACTS"] !== "1") {
    acting.splice(acting.indexOf("typed"), 1);
    if (!shadow.includes("typed")) shadow.push("typed");
    notes.push("The typed-decision server is not calibrated, so it shadows instead of acting (JUHANDU_TYPED_ACTS=1 overrides)");
  }

  const make = (backend: Backend, role: "acted" | "shadow"): Judge | null => {
    const onJudgment = (entry: JudgmentEntry): void => deps.log(role === "shadow" ? { ...entry, role } : entry);
    if (backend === "llm") {
      if (!deps.provider?.capabilities.chat) {
        notes.push("The llm judge needs a chat model and none is configured");
        return null;
      }
      return new LlmJudge({ provider: deps.provider, onJudgment });
    }
    if (backend === "typed") {
      const endpoints = typedEndpoints(env);
      if (!endpoints.length) {
        notes.push("No typed-decision server is configured (JUHANDU_TYPED_URLS)");
        return null;
      }
      // JUHANDU_TYPED_LANE_MODEL, such as "adapter-{lane}", names a model per lane; an explicit JUHANDU_TYPED_MODEL overrides it.
      const template = env["JUHANDU_TYPED_MODEL"] ? undefined : env["JUHANDU_TYPED_LANE_MODEL"];
      const modelFor = template ? (lane: string) => laneModel(template, lane) : undefined;
      return new SystemOneJudge({ name: "typed", endpoints, gate, calibrated: false, onJudgment, ...(modelFor ? { modelFor } : {}), ...fetchOption });
    }
    const apiKey = jevKey(env);
    if (!apiKey) {
      notes.push("No Jev key is configured (JUHANDU_JEV_KEY, JUHANDU_JEV_KEY_FILE, TYPESAFE_API_KEY or JEV_API_KEY)");
      return null;
    }
    const baseUrl = env["JUHANDU_JEV_URL"] ?? "https://api.typesafe.ai";
    return new SystemOneJudge({ name: "jev", endpoints: [{ name: "jev", baseUrl, model: env["JUHANDU_JEV_MODEL"] ?? "jev-preview", local: false, apiKey }], gate, calibrated: true, onJudgment, ...fetchOption });
  };

  const usedJudges = acting.map((b) => make(b, "acted")).filter((j): j is Judge => j !== null);
  const shadowJudges = shadow.filter((b) => !acting.includes(b)).map((b) => make(b, "shadow")).filter((j): j is Judge => j !== null);
  if (!usedJudges.length) {
    if (shadowJudges.length) notes.push("Only shadow judges are configured, so no judge is active");
    return { judge: null, acting: [], shadow, notes };
  }
  const primary = usedJudges.length === 1 ? (usedJudges[0] as Judge) : new ChainJudge(usedJudges);
  return { judge: shadowJudges.length ? new ShadowJudge(primary, shadowJudges) : primary, acting, shadow, notes };
}
