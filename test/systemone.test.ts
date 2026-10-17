import { test } from "node:test";
import assert from "node:assert/strict";
import { ChainJudge, ShadowJudge } from "../src/judges/compose.ts";
import { JudgeError } from "../src/judges/judge.ts";
import type { Judge, PickQuestion, YesNoQuestion } from "../src/judges/judge.ts";
import { buildJudge } from "../src/judges/setup.ts";
import { SystemOneJudge } from "../src/judges/systemone.ts";
import type { SystemOneEndpoint } from "../src/judges/systemone.ts";
import { EgressGate } from "../src/models/egress.ts";
import { ClientError, NoEndpointError } from "../src/models/pool.ts";
import type { ModelProvider } from "../src/models/provider.ts";
import { Store } from "../src/store/store.ts";
import type { JudgmentEntry } from "../src/store/store.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria: unknown; instructions: string }> };
}

type Handler = (call: Call) => Response | Error;

function fakeFetch(handler: Handler, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: JSON.parse(String(init?.body)) as Call["body"] };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
}

const ok = (answers: Record<string, unknown>, model = "typed-model") => new Response(JSON.stringify({ model, answers, usage: { input_tokens: 10 } }), { status: 200, headers: { "content-type": "application/json" } });
const noul = (p: number) => ({ type: "noul", noul: p });
const choice = (probabilities: Record<string, number>) => ({ type: "choice", choice: Object.keys(probabilities)[0], probabilities });
const score = (value: number) => ({ type: "score", score: value });

const CTX = { tier: "public" as const, priority: "background" as const };
const YES_NO: YesNoQuestion = { question: "Do these two items report the same story?", facts: { item_a_title: "OpenAI ships Intelligent UI", item_b_title: "ChatGPT gets Intelligent UI" } };
const PICK: PickQuestion = { question: "Which item is about OpenAI?", options: [{ id: "a", facts: { title: "OpenAI news" } }, { id: "b", facts: { title: "Quest discount" } }, { id: "c", facts: { title: "Rust trait solver" } }] };

function typedEndpoints(...names: string[]): SystemOneEndpoint[] {
  return names.map((name) => ({ name, baseUrl: `http://${name}.test`, model: "jev-preview", local: true }));
}

function judgeFor(handler: Handler, options: { endpoints?: SystemOneEndpoint[]; calibrated?: boolean; log?: JudgmentEntry[]; calls?: Call[]; name?: string } = {}): SystemOneJudge {
  return new SystemOneJudge({
    name: options.name ?? "typed",
    endpoints: options.endpoints ?? typedEndpoints("server-a"),
    gate: new EgressGate(),
    calibrated: options.calibrated ?? false,
    onJudgment: (entry) => options.log?.push(entry),
    fetch: fakeFetch(handler, options.calls),
  });
}

test("yes/no asks the question and its inverse in one request and averages the two", async () => {
  const calls: Call[] = [];
  const log: JudgmentEntry[] = [];
  const judge = judgeFor(() => ok({ answer: noul(0.9), inverse: noul(0.2) }), { calls, log });
  const verdict = await judge.yesNo(YES_NO, CTX);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://server-a.test/v1/systemone");
  assert.equal(calls[0]!.headers["authorization"], undefined, "the typed server needs no key");
  assert.deepEqual(calls[0]!.body.state["subject"], YES_NO.facts);
  assert.deepEqual(Object.keys(calls[0]!.body.questions), ["answer", "inverse"]);
  assert.equal(calls[0]!.body.questions["answer"]!.type, "noul");
  assert.ok(Math.abs(verdict.probability - 0.85) < 1e-9);
  assert.ok(Math.abs((verdict.disagreement ?? 0) - 0.1) < 1e-9);
  assert.equal(verdict.answer, true);
  assert.equal(verdict.calibrated, false);
  assert.equal(verdict.model, "typed-model");
  assert.equal(log.length, 1);
  assert.equal(log[0]!.provider, "typed");
  assert.equal(log[0]!.kind, "yes_no");
});

test("a hosted endpoint gets its key as a bearer token and its answers count as calibrated", async () => {
  const calls: Call[] = [];
  const endpoint: SystemOneEndpoint = { name: "jev", baseUrl: "https://api.typesafe.ai/v1/systemone", model: "jev-preview", local: false, apiKey: "test-key" };
  const judge = judgeFor(() => ok({ answer: noul(0.05), inverse: noul(0.97) }, "jev-preview"), { endpoints: [endpoint], calibrated: true, calls, name: "jev" });
  const verdict = await judge.yesNo(YES_NO, CTX);
  assert.equal(calls[0]!.url, "https://api.typesafe.ai/v1/systemone", "a full URL is not extended twice");
  assert.equal(calls[0]!.headers["authorization"], "Bearer test-key");
  assert.equal(verdict.answer, false);
  assert.equal(verdict.calibrated, true);
});

test("pick-one averages the forward and the reversed option order", async () => {
  const calls: Call[] = [];
  const judge = judgeFor(() => ok({ pick: choice({ a: 0.6, b: 0.3, c: 0.1 }), pick_reversed: choice({ a: 0.4, b: 0.5, c: 0.1 }) }), { calls });
  const verdict = await judge.pickOne(PICK, CTX);
  assert.deepEqual(Object.keys(calls[0]!.body.questions["pick"]!.criteria as object), ["a", "b", "c"]);
  assert.deepEqual(Object.keys(calls[0]!.body.questions["pick_reversed"]!.criteria as object), ["c", "b", "a"]);
  assert.equal(verdict.id, "a");
  assert.ok(Math.abs((verdict.probabilities["a"] ?? 0) - 0.5) < 1e-9);
  assert.ok(Math.abs((verdict.probabilities["b"] ?? 0) - 0.4) < 1e-9);
  await assert.rejects(judge.pickOne({ question: "x", options: [PICK.options[0]!] }, CTX), JudgeError);
});

test("rank scores each option on a scale and its reverse, and orders by the averaged score", async () => {
  const calls: Call[] = [];
  const scores: Record<string, [number, number]> = { a: [4, 0], b: [2, 2], c: [0, 4] };
  const judge = judgeFor(
    (call) => {
      const id = (call.body.state["candidate"] as { id: string }).id;
      const [forward, reversed] = scores[id] as [number, number];
      return ok({ fit: score(forward), fit_reversed: score(reversed) });
    },
    { calls },
  );
  const verdict = await judge.rank({ ...PICK, options: [PICK.options[2]!, PICK.options[0]!, PICK.options[1]!] }, CTX);
  assert.deepEqual(verdict.order, ["a", "b", "c"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]!.body.state["all_candidates_being_compared"], ["c", "a", "b"]);
  const levels = calls[0]!.body.questions["fit"]!.criteria as string[];
  assert.deepEqual(calls[0]!.body.questions["fit_reversed"]!.criteria, [...levels].reverse());
});

test("a server that is down is skipped and the next one answers; a busy one is skipped too", async () => {
  const calls: Call[] = [];
  const judge = judgeFor(
    (call) => {
      if (call.url.startsWith("http://server-a.test")) return new Error("connect ECONNREFUSED");
      if (call.url.startsWith("http://server-b.test")) return new Response("busy", { status: 429 });
      return ok({ answer: noul(0.8), inverse: noul(0.2) });
    },
    { endpoints: typedEndpoints("server-a", "server-b", "server-c"), calls },
  );
  assert.equal((await judge.yesNo(YES_NO, CTX)).answer, true);
  assert.deepEqual(calls.map((c) => new URL(c.url).hostname), ["server-a.test", "server-b.test", "server-c.test"]);
  await judge.yesNo(YES_NO, CTX);
  assert.deepEqual(calls.slice(3).map((c) => new URL(c.url).hostname), ["server-c.test"], "the failed servers are remembered for a while");
  assert.equal(judge.status().filter((s) => s.skippedForMs > 0).length, 2);
});

test("a rejected request is not retried elsewhere, and a reply without answers is a JudgeError", async () => {
  const calls: Call[] = [];
  const bad = judgeFor(() => new Response("no", { status: 400 }), { endpoints: typedEndpoints("server-a", "server-b"), calls });
  await assert.rejects(bad.yesNo(YES_NO, CTX), ClientError);
  assert.equal(calls.length, 1);
  await assert.rejects(judgeFor(() => ok({})).yesNo(YES_NO, CTX), JudgeError);
  await assert.rejects(judgeFor(() => ok({ answer: { type: "noul" }, inverse: noul(0.5) })).yesNo(YES_NO, CTX), JudgeError);
});

test("private data never reaches a hosted endpoint unless it is allowed", async () => {
  const calls: Call[] = [];
  const hosted: SystemOneEndpoint = { name: "jev", baseUrl: "https://jev.test", model: "jev-preview", local: false, apiKey: "k" };
  const judge = judgeFor(() => ok({ answer: noul(0.9), inverse: noul(0.1) }), { endpoints: [hosted], calls, name: "jev" });
  await assert.rejects(judge.yesNo(YES_NO, { tier: "private", priority: "background" }), NoEndpointError);
  assert.equal(calls.length, 0);
  assert.equal((await judge.yesNo(YES_NO, CTX)).answer, true);
});

function stub(name: string, outcome: "yes" | "no" | Error): Judge {
  const fail = (): never => {
    throw outcome as Error;
  };
  return {
    yesNo: async () => (outcome instanceof Error ? fail() : { answer: outcome === "yes", probability: outcome === "yes" ? 1 : 0, calibrated: true, model: name }),
    pickOne: async () => (outcome instanceof Error ? fail() : { id: name, probabilities: { [name]: 1 }, calibrated: true, model: name }),
    rank: async () => (outcome instanceof Error ? fail() : { order: [name], model: name }),
  };
}

test("a chain uses the first judge that answers and queues only when every judge is unavailable", async () => {
  const down = new NoEndpointError("down");
  assert.equal((await new ChainJudge([stub("first", down), stub("second", "yes")]).yesNo(YES_NO, CTX)).model, "second");
  assert.equal((await new ChainJudge([stub("first", new JudgeError("garbled")), stub("second", "no")]).pickOne(PICK, CTX)).id, "second");
  await assert.rejects(new ChainJudge([stub("a", down), stub("b", down)]).yesNo(YES_NO, CTX), NoEndpointError);
  await assert.rejects(new ChainJudge([stub("a", down), stub("b", new JudgeError("garbled"))]).yesNo(YES_NO, CTX), JudgeError);
  await assert.rejects(new ChainJudge([stub("a", new TypeError("a bug"))]).yesNo(YES_NO, CTX), TypeError, "a bug is not swallowed as an outage");
});

test("a shadow judge is asked the same question but never changes, delays a failure of, or fails the answer", async () => {
  const log: JudgmentEntry[] = [];
  let asked = 0;
  const shadow = judgeFor(() => (asked++, ok({ answer: noul(0.1), inverse: noul(0.9) })), { log });
  const judge = new ShadowJudge(stub("primary", "yes"), [shadow, stub("broken", new Error("boom"))]);
  const verdict = await judge.yesNo(YES_NO, CTX);
  assert.equal(verdict.answer, true);
  assert.equal(verdict.model, "primary");
  assert.equal(asked, 1);
  assert.equal(log.length, 1, "the shadow answer is logged");
  await assert.rejects(new ShadowJudge(stub("primary", new NoEndpointError("down")), [shadow]).yesNo(YES_NO, CTX), NoEndpointError);
  assert.equal(asked, 1, "a failed primary does not trigger the shadows");
});

const chatProvider = { name: "fake", capabilities: { embed: false, chat: true, decide: false, transcribe: false } } as unknown as ModelProvider;

function setup(env: Record<string, string>, provider: ModelProvider | null = chatProvider, entries: JudgmentEntry[] = []) {
  return buildJudge({ ...env }, { provider, log: (e) => entries.push(e), fetch: fakeFetch(() => ok({ answer: noul(0.9), inverse: noul(0.1) })) });
}

test("setup defaults to the llm judge and keeps the uncalibrated typed server in the shadows", async () => {
  assert.deepEqual([setup({}).acting, setup({}).judge === null], [["llm"], false]);
  assert.equal(setup({}, null).judge, null);
  const typed = setup({ JUHANDU_JUDGE: "typed", JUHANDU_TYPED_URLS: "http://server-a.test" });
  assert.deepEqual(typed.acting, []);
  assert.deepEqual(typed.shadow, ["typed"]);
  assert.equal(typed.judge, null);
  assert.ok(typed.notes.some((n) => /not calibrated/.test(n)));
  const acts = setup({ JUHANDU_JUDGE: "typed", JUHANDU_TYPED_URLS: "http://server-a.test", JUHANDU_TYPED_ACTS: "1" });
  assert.deepEqual(acts.acting, ["typed"]);
  assert.notEqual(acts.judge, null);
});

test("setup reports what it could not build instead of failing", async () => {
  const none = setup({ JUHANDU_JUDGE: "llm,typed,jev,magic", JUHANDU_TYPED_ACTS: "1" }, null);
  assert.equal(none.judge, null);
  assert.ok(none.notes.some((n) => /magic/.test(n)));
  assert.ok(none.notes.some((n) => /No typed-decision server/.test(n)));
  assert.ok(none.notes.some((n) => /No Jev key/.test(n)));
  assert.ok(none.notes.some((n) => /needs a chat model/.test(n)));
});

test("a configured chain acts with the first judge and logs the shadows with their role", async () => {
  const entries: JudgmentEntry[] = [];
  const built = setup({ JUHANDU_JUDGE: "jev", JUHANDU_JEV_KEY: "k", JUHANDU_JUDGE_SHADOW: "typed", JUHANDU_TYPED_URLS: "http://server-a.test" }, null, entries);
  assert.deepEqual([built.acting, built.shadow], [["jev"], ["typed"]]);
  const verdict = await built.judge!.yesNo(YES_NO, CTX);
  assert.equal(verdict.calibrated, true);
  assert.deepEqual(entries.map((e) => [e.provider, e.role ?? "acted"]), [["jev", "acted"], ["typed", "shadow"]]);
});

test("the judge log keeps the role of each row", async () => {
  const store = new Store(":memory:");
  const base: JudgmentEntry = { kind: "yes_no", question: "q", input: {}, output: {}, model: "m", provider: "typed", priority: "background", tier: "public" };
  store.logJudgment(base);
  store.logJudgment({ ...base, role: "shadow" });
  assert.deepEqual(store.recentJudgments(5).map((j) => j.role), ["shadow", "acted"]);
  store.close();
});

const GATEWAY = "http://gateway.test/v1/systemone";
const DIRECT = "http://direct.test/v1/systemone";
const own = (status: number, extra: Record<string, string> = {}) => new Response("{}", { status, headers: { "x-augur-gateway": "1", ...extra } });
const OK_ANSWERS = { answer: noul(0.9), inverse: noul(0.2) };

function gatewayJudge(handler: Handler, calls: Call[], options: { direct?: boolean } = {}): SystemOneJudge {
  const endpoint: SystemOneEndpoint = { name: "jev", baseUrl: DIRECT, model: "jev-preview", local: false, gateway: { url: GATEWAY, token: "gw-token" }, ...(options.direct === false ? {} : { apiKey: "direct-key" }) };
  return judgeFor(handler, { endpoints: [endpoint], calls, name: "jev", calibrated: true });
}

test("the gateway is tried first with its token, the consumer and a public tier", async () => {
  const calls: Call[] = [];
  await gatewayJudge(() => ok(OK_ANSWERS, "jev-1.14.0"), calls).yesNo(YES_NO, CTX);
  assert.deepEqual(calls.map((c) => c.url), [GATEWAY]);
  assert.equal(calls[0]!.headers["authorization"], "Bearer gw-token");
  assert.equal(calls[0]!.headers["x-augur-consumer"], "juhandu");
  assert.equal(calls[0]!.headers["x-augur-data"], "public");
});

test("a private item is declared sensitive to the gateway", async () => {
  const calls: Call[] = [];
  const judge = new SystemOneJudge({ name: "jev", endpoints: [{ name: "jev", baseUrl: DIRECT, model: "jev-preview", local: false, gateway: { url: GATEWAY, token: "t" } }], gate: new EgressGate(["jev"]), calibrated: true, fetch: fakeFetch(() => ok(OK_ANSWERS), calls) });
  await judge.yesNo(YES_NO, { tier: "private", priority: "background" });
  assert.equal(calls[0]!.headers["x-augur-data"], "sensitive");
});

test("an unreachable gateway or its own 503 goes direct with the direct key", async () => {
  for (const down of [new Error("refused"), own(503), own(502)]) {
    const calls: Call[] = [];
    await gatewayJudge((call) => (call.url === GATEWAY ? down : ok(OK_ANSWERS)), calls).yesNo(YES_NO, CTX);
    assert.deepEqual(calls.map((c) => c.url), [GATEWAY, DIRECT]);
    assert.equal(calls[1]!.headers["authorization"], "Bearer direct-key");
    assert.equal(calls[1]!.headers["x-augur-consumer"], undefined);
  }
});

test("a gateway refusal is never retried direct", async () => {
  const calls: Call[] = [];
  await assert.rejects(gatewayJudge(() => own(503, { "x-augur-refused": "1" }), calls).yesNo(YES_NO, CTX), ClientError);
  assert.deepEqual(calls.map((c) => c.url), [GATEWAY]);
});

test("an upstream error from the gateway passes through without a direct retry", async () => {
  const calls: Call[] = [];
  await assert.rejects(gatewayJudge(() => new Response("{}", { status: 422 }), calls).yesNo(YES_NO, CTX), ClientError);
  assert.deepEqual(calls.map((c) => c.url), [GATEWAY]);
});

test("with no direct key an unreachable gateway means no endpoint is available", async () => {
  const calls: Call[] = [];
  await assert.rejects(gatewayJudge(() => new Error("refused"), calls, { direct: false }).yesNo(YES_NO, CTX), NoEndpointError);
  assert.deepEqual(calls.map((c) => c.url), [GATEWAY]);
});

test("buildJudge builds a Jev judge from the gateway settings alone", () => {
  const env = { JUHANDU_JUDGE: "jev", JUHANDU_JEV_GATEWAY_URL: GATEWAY, JUHANDU_JEV_GATEWAY_TOKEN: "t" };
  const setup = buildJudge(env, { provider: null, log: () => {} });
  assert.deepEqual(setup.acting, ["jev"]);
  assert.ok(setup.judge);
  assert.equal(buildJudge({ JUHANDU_JUDGE: "jev", JUHANDU_JEV_GATEWAY_URL: GATEWAY }, { provider: null, log: () => {} }).judge, null, "a gateway URL without a token is not enough");
});
