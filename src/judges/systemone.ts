import type { EgressGate, EndpointInfo } from "../models/egress.ts";
import { assertUsable, joinUrl } from "../models/openai.ts";
import { ClientError, EndpointPool } from "../models/pool.ts";
import type { JudgmentEntry } from "../store/store.ts";
import { JudgeError } from "./judge.ts";
import type { Facts, Judge, JudgeContext, PickQuestion, PickVerdict, RankVerdict, YesNoQuestion, YesNoVerdict } from "./judge.ts";

/** A server that speaks the typed-decision protocol (POST /v1/systemone): a self-hosted server, or the hosted Jev service. */
export interface SystemOneEndpoint extends EndpointInfo {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Augur's Jev gateway. When set, a request goes there first and reaches baseUrl directly only if the gateway cannot be reached or fails on its own. */
  gateway?: { url: string; token: string };
}

export interface SystemOneJudgeOptions {
  /** "typed" or "jev"; recorded as the provider on every judgment. */
  name: string;
  endpoints: SystemOneEndpoint[];
  gate: EgressGate;
  /** Whether the probabilities the server reports can be trusted as measured. Hosted Jev is calibrated; a self-hosted server is not assumed to be. */
  calibrated: boolean;
  onJudgment?: (entry: JudgmentEntry) => void;
  /** The model name to send for a lane, when it should differ from the endpoint's own. A server can serve one adapter per lane, named by model. */
  modelFor?: (lane: string) => string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Answer = Record<string, unknown>;

interface Reply {
  answers: Record<string, Answer>;
  model: string;
}

const LEVELS = ["Does not answer the question at all", "Answers the question poorly", "Answers the question partly", "Answers the question well", "Answers the question better than any other item"];

function line(facts: Facts): string {
  return Object.entries(facts)
    .map(([key, value]) => `${key}: ${value}`)
    .join("; ");
}

/** The request that asks one yes/no question both ways. The training export builds its rows from the same function, so a trained adapter sees exactly what the judge sends. */
export function yesNoRequest(q: YesNoQuestion): { state: Record<string, unknown>; questions: Record<string, unknown> } {
  return {
    state: { question: q.question, subject: q.facts },
    questions: {
      answer: { type: "noul", instructions: q.question, criteria: { true: "The answer to the question is yes.", false: "The answer to the question is no." } },
      inverse: { type: "noul", instructions: `Is the answer to this question no? ${q.question}`, criteria: { true: "The answer to the question is no.", false: "The answer to the question is yes." } },
    },
  };
}

function number01(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new JudgeError(`The decision server returned no usable ${what}`);
  return value;
}

function answerOf(reply: Reply, name: string, type: string): Answer {
  const answer = reply.answers[name];
  if (!answer || typeof answer !== "object" || answer["type"] !== type) throw new JudgeError(`The decision server did not answer "${name}" as a ${type}`);
  return answer;
}

/** Judge over the /v1/systemone protocol. Each decision is asked twice in one request, the second time phrased the other way round (inverse yes/no, reversed options, reversed score levels), and the two answers are averaged so a server that leans on wording or order shows it as disagreement (the same discipline the project's other decision tooling uses). */
export class SystemOneJudge implements Judge {
  private readonly name: string;
  private readonly pool: EndpointPool<SystemOneEndpoint>;
  private readonly calibrated: boolean;
  private readonly onJudgment: ((entry: JudgmentEntry) => void) | undefined;
  private readonly modelFor: ((lane: string) => string | undefined) | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SystemOneJudgeOptions) {
    this.name = options.name;
    this.pool = new EndpointPool(options.endpoints, options.gate);
    this.calibrated = options.calibrated;
    this.onJudgment = options.onJudgment;
    this.modelFor = options.modelFor;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  status(): { name: string; local: boolean; skippedForMs: number }[] {
    return this.pool.status();
  }

  private async post(context: JudgeContext, state: Record<string, unknown>, questions: Record<string, unknown>): Promise<Reply> {
    return this.pool.run(context.tier, async (endpoint) => {
      const model = (context.lane ? this.modelFor?.(context.lane) : undefined) ?? endpoint.model;
      const body = JSON.stringify({ model, state, questions });
      const send = (url: string, headers: Record<string, string>): Promise<Response> => this.fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      let response: Response | null = null;
      if (endpoint.gateway) response = await this.viaGateway(endpoint, endpoint.gateway, context, send);
      if (response === null) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (endpoint.apiKey) headers["authorization"] = `Bearer ${endpoint.apiKey}`;
        response = await send(endpoint.baseUrl.endsWith("/v1/systemone") ? endpoint.baseUrl : joinUrl(endpoint.baseUrl, "/v1/systemone"), headers);
      }
      assertUsable(endpoint.name, response);
      const reply = (await response.json()) as { answers?: Record<string, Answer>; model?: unknown };
      if (!reply.answers || typeof reply.answers !== "object") throw new JudgeError(`${endpoint.name} returned no answers`);
      return { answers: reply.answers, model: typeof reply.model === "string" ? reply.model : endpoint.model };
    });
  }

  /** The gateway's answer, or null when the request should go direct: it could not be reached, or it failed on its own (502 or 503 carrying its own header). A refusal is never retried direct, because the gateway refuses on purpose (data it will not send to hosted Jev). Private items are declared sensitive so the gateway keeps them off hosted Jev. */
  private async viaGateway(endpoint: SystemOneEndpoint, gateway: { url: string; token: string }, context: JudgeContext, send: (url: string, headers: Record<string, string>) => Promise<Response>): Promise<Response | null> {
    const headers = { "content-type": "application/json", authorization: `Bearer ${gateway.token}`, "x-augur-consumer": "juhandu", "x-augur-data": context.tier === "private" ? "sensitive" : "public" };
    let response: Response;
    try {
      response = await send(gateway.url, headers);
    } catch {
      if (!endpoint.apiKey) throw new Error(`${endpoint.name} gateway is unreachable and no direct key is set`);
      return null;
    }
    const own = response.headers.get("x-augur-gateway") !== null;
    if (own && (response.status === 502 || response.status === 503) && response.headers.get("x-augur-refused") === null) {
      if (!endpoint.apiKey) throw new Error(`${endpoint.name} gateway answered ${response.status} and no direct key is set`);
      return null;
    }
    if (own && response.headers.get("x-augur-refused") !== null) throw new ClientError(response.status, `${endpoint.name} gateway refused the request (${response.status})`);
    return response;
  }

  private record(kind: string, question: string, input: unknown, output: unknown, model: string, context: JudgeContext): void {
    this.onJudgment?.({ kind, question, input, output, model, provider: this.name, priority: context.priority, tier: context.tier, ...(context.lane ? { lane: context.lane } : {}) });
  }

  async yesNo(q: YesNoQuestion, context: JudgeContext): Promise<YesNoVerdict> {
    const request = yesNoRequest(q);
    const reply = await this.post(context, request.state, request.questions);
    const direct = number01(answerOf(reply, "answer", "noul")["noul"], "yes probability");
    const inverse = 1 - number01(answerOf(reply, "inverse", "noul")["noul"], "inverse probability");
    const probability = (direct + inverse) / 2;
    const verdict: YesNoVerdict = { answer: probability >= 0.5, probability, calibrated: this.calibrated, model: reply.model, disagreement: Math.abs(direct - inverse) };
    this.record("yes_no", q.question, q.facts, verdict, reply.model, context);
    return verdict;
  }

  async pickOne(q: PickQuestion, context: JudgeContext): Promise<PickVerdict> {
    if (q.options.length < 2 || q.options.length > 26) throw new JudgeError("pickOne needs between 2 and 26 options");
    const criteria = (options: PickQuestion["options"]) => Object.fromEntries(options.map((o) => [o.id, line(o.facts)]));
    const reply = await this.post(
      context,
      { question: q.question },
      {
        pick: { type: "choice", instructions: q.question, criteria: criteria(q.options) },
        pick_reversed: { type: "choice", instructions: q.question, criteria: criteria([...q.options].reverse()) },
      },
    );
    const forward = answerOf(reply, "pick", "choice")["probabilities"] as Record<string, number> | undefined;
    const backward = answerOf(reply, "pick_reversed", "choice")["probabilities"] as Record<string, number> | undefined;
    if (!forward || !backward) throw new JudgeError("The decision server returned no option probabilities");
    const probabilities = Object.fromEntries(q.options.map((o) => [o.id, ((forward[o.id] ?? 0) + (backward[o.id] ?? 0)) / 2]));
    const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] as [string, number];
    const verdict: PickVerdict = { id: best[0], probabilities, calibrated: this.calibrated, model: reply.model };
    this.record("pick_one", q.question, q.options, verdict, reply.model, context);
    return verdict;
  }

  /** Scores every option on one 5-level scale ("how well does it answer the question") and orders by the averaged score, ties kept in the order given. */
  async rank(q: PickQuestion, context: JudgeContext): Promise<RankVerdict> {
    if (q.options.length < 2) throw new JudgeError("rank needs at least 2 items");
    const ids = q.options.map((o) => o.id);
    const top = LEVELS.length - 1;
    const scored = await Promise.all(
      q.options.map(async (option) => {
        const reply = await this.post(
          context,
          { question: q.question, candidate: { id: option.id, ...option.facts }, all_candidates_being_compared: ids },
          {
            fit: { type: "score", instructions: q.question, criteria: LEVELS },
            fit_reversed: { type: "score", instructions: q.question, criteria: [...LEVELS].reverse() },
          },
        );
        const a = answerOf(reply, "fit", "score")["score"];
        const b = answerOf(reply, "fit_reversed", "score")["score"];
        if (typeof a !== "number" || typeof b !== "number") throw new JudgeError("The decision server returned no score");
        return { id: option.id, score: (a + (top - b)) / (2 * top), model: reply.model };
      }),
    );
    const order = [...scored].sort((x, y) => y.score - x.score).map((s) => s.id);
    const model = scored[0]?.model ?? "";
    const verdict: RankVerdict = { order, model };
    this.record("rank", q.question, q.options, { order, scores: Object.fromEntries(scored.map((s) => [s.id, s.score])) }, model, context);
    return verdict;
  }
}
