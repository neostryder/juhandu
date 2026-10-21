import { test } from "node:test";
import assert from "node:assert/strict";
import { CogitatorProvider, keyFromValue } from "../src/models/cogitator.ts";
import type { Discovery } from "../src/models/cogitator.ts";
import { Embedder, promptsFor } from "../src/models/embedder.ts";
import { EgressGate } from "../src/models/egress.ts";
import { OpenAICompatibleProvider } from "../src/models/generic.ts";
import type { OpenAIEndpoint } from "../src/models/openai.ts";
import { EndpointPool, NoEndpointError } from "../src/models/pool.ts";
import { DeferredError, ModelMismatchError } from "../src/models/provider.ts";
import type { ChatRequest, ModelProvider } from "../src/models/provider.ts";
import { buildEmbedder, buildProvider, defaultDiscoveryFile, discoveryCandidates } from "../src/models/setup.ts";
import { JudgeError, LlmJudge, classMass } from "../src/judges/judge.ts";
import { Processor } from "../src/pipeline/process.ts";
import { Store } from "../src/store/store.ts";
import type { NewItem } from "../src/store/store.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";

const DISCOVERY: Discovery = {
  schema: 1,
  openai_base: "http://cog.test/v1",
  health: "http://cog.test/health",
  roles: [
    { name: "describe", chain: ["gemma-4-12b"] },
    { name: "embed", chain: ["nomic-embed-text-v1.5"] },
  ],
  models: [{ id: "gemma-4-12b" }, { id: "nomic-embed-text-v1.5" }],
};

interface Call {
  path: string;
  auth: string;
  body: Record<string, any>;
}

interface FakeOptions {
  discovery?: Discovery;
  /** Answers handed out in order for the next calls to a model route; a Response is returned as is. */
  script?: (Response | "ok")[];
  embedModelHeader?: string;
  chatText?: string;
  yesProbability?: number;
}

/** A fake OpenAI-style model host that behaves like Cogitator when `cogitator` is set (discovery and the served-model header). */
function fakeHost(calls: Call[], options: FakeOptions = {}, cogitator = true): FetchLike {
  const script = [...(options.script ?? [])];
  return async (url, init) => {
    const path = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (path === "/v1/cogitator/discovery") return new Response(JSON.stringify(options.discovery ?? DISCOVERY), { status: 200 });
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    calls.push({ path, auth: headers["authorization"] ?? "", body });
    const next = script.shift();
    if (next && next !== "ok") return next;
    const extra: Record<string, string> = cogitator ? { "x-cogitator-model": path.endsWith("embeddings") ? (options.embedModelHeader ?? "nomic-embed-text-v1.5") : "gemma-4-12b" } : {};
    if (path.endsWith("/embeddings")) {
      const input = body["input"] as string[];
      return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: [t.length, 1, 0] })) }), { status: 200, headers: extra });
    }
    const yes = options.yesProbability ?? 0.8;
    const message = { content: options.chatText ?? "Yes" };
    const logprobs = body["logprobs"]
      ? { content: [{ top_logprobs: [{ token: "Yes", logprob: Math.log(yes) }, { token: " no", logprob: Math.log(1 - yes) }, { token: "A", logprob: Math.log(0.7) }, { token: "B", logprob: Math.log(0.3) }] }] }
      : null;
    return new Response(JSON.stringify({ model: "gemma-4-12b", choices: [{ message, logprobs }] }), { status: 200, headers: extra });
  };
}

function cogitator(fetchImpl: FetchLike, extra: Partial<ConstructorParameters<typeof CogitatorProvider>[0]> = {}): CogitatorProvider {
  return new CogitatorProvider({ gatewayUrl: "http://cog.test", backgroundKey: keyFromValue("low-secret"), interactiveKey: keyFromValue("normal-secret"), fetchImpl, ...extra });
}

function generic(fetchImpl: FetchLike): OpenAICompatibleProvider {
  const endpoint = (name: string): OpenAIEndpoint => ({ name, baseUrl: "http://plain.test/v1", model: name === "chat" ? "any-chat" : "any-embed", local: true });
  const gate = new EgressGate();
  return new OpenAICompatibleProvider({ embedPool: new EndpointPool([endpoint("embed")], gate), chatPool: new EndpointPool([endpoint("chat")], gate), embedTag: "any-embed-q8", fetchImpl });
}

test("a gateway that advertises its loopback address is called at the address the client reached it on", async () => {
  const hosts: string[] = [];
  const inner = fakeHost([], { discovery: { ...DISCOVERY, openai_base: "http://127.0.0.1:8470/v1" } });
  const provider = cogitator(async (url, init) => {
    hosts.push(new URL(url).origin);
    return inner(url, init);
  }, { gatewayUrl: "http://192.168.2.100:8470" });
  const result = await provider.embed({ tier: "public", priority: "background", texts: ["a"] });
  assert.equal(result.vectors.length, 1);
  assert.deepEqual([...new Set(hosts)], ["http://192.168.2.100:8470"]);
  const local = cogitator(async (url, init) => {
    hosts.push(new URL(url).origin);
    return inner(url, init);
  }, { gatewayUrl: "http://127.0.0.1:8470" });
  hosts.length = 0;
  await local.embed({ tier: "public", priority: "background", texts: ["a"] });
  assert.deepEqual([...new Set(hosts)], ["http://127.0.0.1:8470"]);
});

test("the Cogitator adapter asks for a role by job name and picks the key class by priority", async () => {
  const calls: Call[] = [];
  const provider = cogitator(fakeHost(calls));
  assert.equal(await provider.embeddingModel(), "nomic-embed-text-v1.5");
  const background = await provider.embed({ tier: "public", priority: "background", texts: ["a", "bb"] });
  const interactive = await provider.embed({ tier: "public", priority: "interactive", texts: ["c"] });
  assert.equal(background.vectors.length, 2);
  assert.equal(background.model, "nomic-embed-text-v1.5");
  assert.equal(interactive.vectors.length, 1);
  assert.equal(calls[0]!.auth, "Bearer low-secret");
  assert.equal(calls[1]!.auth, "Bearer normal-secret");
  assert.equal(calls[0]!.body["model"], "embed");
});

test("summarize and judge fall back to describe, and use their own role when Cogitator has one", async () => {
  const calls: Call[] = [];
  const request: Omit<ChatRequest, "job"> = { tier: "public", priority: "background", messages: [{ role: "user", content: "hi" }] };
  const plain = cogitator(fakeHost(calls));
  await plain.chat({ ...request, job: "judge" });
  await plain.chat({ ...request, job: "summarize" });
  assert.deepEqual(calls.map((c) => c.body["model"]), ["describe", "describe"]);
  calls.length = 0;
  const richer: Discovery = { ...DISCOVERY, roles: [...DISCOVERY.roles, { name: "judge", chain: ["gemma-4-e4b-it-qat"] }] };
  const custom = cogitator(fakeHost(calls, { discovery: richer }));
  await custom.chat({ ...request, job: "judge" });
  await custom.chat({ ...request, job: "summarize" });
  assert.deepEqual(calls.map((c) => c.body["model"]), ["judge", "describe"]);
  const renamed = cogitator(fakeHost(calls), { roles: { summarize: "embed" } });
  calls.length = 0;
  await renamed.chat({ ...request, job: "summarize" });
  assert.equal(calls[0]!.body["model"], "embed");
});

test("a deferral never drops background work and is waited out for interactive work", async () => {
  const deferred = () => new Response(JSON.stringify({ error: { code: "deferred" } }), { status: 503, headers: { "retry-after": "5" } });
  const calls: Call[] = [];
  const request = { tier: "public" as const, texts: ["a"] };
  const background = cogitator(fakeHost(calls, { script: [deferred()] }));
  await assert.rejects(background.embed({ ...request, priority: "background" }), (error: unknown) => error instanceof DeferredError && error.retryAfterMs === 5000 && error instanceof NoEndpointError);
  let now = 0;
  const slept: number[] = [];
  const patient = cogitator(fakeHost(calls, { script: [deferred(), deferred()] }), {
    clock: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  });
  const result = await patient.embed({ ...request, priority: "interactive" });
  assert.equal(result.vectors.length, 1);
  assert.deepEqual(slept, [5000, 5000]);
  const impatient = cogitator(fakeHost(calls, { script: [deferred(), deferred(), deferred()] }), { clock: () => now, sleep: async (ms) => void (now += ms), interactiveWaitMs: 8_000 });
  await assert.rejects(impatient.embed({ ...request, priority: "interactive" }), DeferredError);
});

test("a rejected key is a client error and an unreachable host queues the work", async () => {
  const calls: Call[] = [];
  const denied = cogitator(fakeHost(calls, { script: [new Response("no", { status: 401 })] }));
  await assert.rejects(denied.embed({ tier: "public", priority: "background", texts: ["a"] }), /rejected the key/);
  const down = cogitator(async (url) => {
    if (url.includes("discovery")) return new Response(JSON.stringify(DISCOVERY), { status: 200 });
    throw new Error("connection refused");
  });
  await assert.rejects(down.embed({ tier: "public", priority: "background", texts: ["a"] }), NoEndpointError);
  const absent = cogitator(async () => {
    throw new Error("no route");
  });
  assert.equal(await absent.embeddingModel(), null);
});

test("vectors from a different embedding model than the tag are refused and queued", async () => {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed" });
  const item: NewItem = { guid: "1", url: "https://x.example/1", title: "Rust news", author: "", publishedAt: "2026-10-06T08:00:00Z", summaryText: "", contentHtml: "", image: "", titleHash: "1", extra: {} };
  store.upsertItems(source.id, [item]);
  const calls: Call[] = [];
  const provider = cogitator(fakeHost(calls, { embedModelHeader: "some-other-embedder" }));
  const processor = new Processor(store, new Embedder({ provider }));
  const result = await processor.run();
  assert.equal(result.embedded, 0);
  await assert.rejects(provider.embed({ tier: "public", priority: "background", texts: ["a"] }), ModelMismatchError);
  const healthy = new Processor(store, new Embedder({ provider: cogitator(fakeHost(calls)) }));
  assert.equal((await healthy.run()).embedded, 1);
  assert.equal(store.getEmbedding(1, "nomic-embed-text-v1.5")?.length, 3);
  store.close();
});

test("the embedder tags truncated vectors with their dimensions", async () => {
  const embedder = new Embedder({ provider: cogitator(fakeHost([])), dims: 2 });
  assert.equal(await embedder.tag(), "nomic-embed-text-v1.5@2");
  const out = await embedder.documents("public", "background", ["abc"]);
  assert.equal(out.tag, "nomic-embed-text-v1.5@2");
  assert.equal(out.vectors[0]!.length, 2);
});

const WITH_GEMMA: Discovery = { ...DISCOVERY, roles: [...DISCOVERY.roles, { name: "embed-gemma2", chain: ["embeddinggemma-2", "embeddinggemma-2@bilbo"] }] };

test("the embedding role is the one asked for, falls back to the older embed role, and a failover peer's name is not a different model", async () => {
  const calls: Call[] = [];
  const wanted = cogitator(fakeHost(calls, { discovery: WITH_GEMMA, embedModelHeader: "embeddinggemma-2@bilbo" }), { roles: { embed: "embed-gemma2" } });
  assert.equal(await wanted.embeddingModel(), "embeddinggemma-2");
  const served = await wanted.embed({ tier: "public", priority: "background", texts: ["a"] });
  assert.equal(served.model, "embeddinggemma-2", "the peer that answered is dropped from the model name");
  assert.equal(calls[0]!.body["model"], "embed-gemma2");
  const older = cogitator(fakeHost(calls), { roles: { embed: "embed-gemma2" } });
  assert.equal(await older.embeddingModel(), "nomic-embed-text-v1.5", "a gateway without the new role keeps serving the old one");
  calls.length = 0;
  await older.embed({ tier: "public", priority: "background", texts: ["a"] });
  assert.equal(calls[0]!.body["model"], "embed");
});

test("each embedding model gets the prefixes it was trained with, and an environment prefix overrides them", async () => {
  assert.deepEqual(promptsFor("embeddinggemma-2"), { document: "title: none | text: ", query: "task: search result | query: " });
  assert.deepEqual(promptsFor("nomic-embed-text-v1.5"), { document: "clustering: ", query: "clustering: " });
  const calls: Call[] = [];
  const gemma = new Embedder({ provider: cogitator(fakeHost(calls, { discovery: WITH_GEMMA, embedModelHeader: "embeddinggemma-2" }), { roles: { embed: "embed-gemma2" } }) });
  await gemma.documents("public", "background", ["story"]);
  await gemma.queries("background", ["a rule"]);
  assert.deepEqual(calls.map((c) => c.body["input"]), [["title: none | text: story"], ["task: search result | query: a rule"]]);
  calls.length = 0;
  const forced = new Embedder({ provider: cogitator(fakeHost(calls)), documentPrefix: "doc: ", queryPrefix: "q: " });
  await forced.documents("public", "background", ["x"]);
  await forced.queries("background", ["y"]);
  assert.deepEqual(calls.map((c) => c.body["input"]), [["doc: x"], ["q: y"]]);
});

test("an embedding endpoint that is not local is never used, unless it is marked local", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const remote = { JUHANDU_EMBED_URL: "https://embed.example.com/v1" };
    assert.equal(buildProvider(remote, "/tmp/x"), null);
    assert.equal(buildEmbedder(buildProvider({ ...remote, JUHANDU_CHAT_URL: "http://127.0.0.1:8181/v1" }, "/tmp/x"), {}), null);
    assert.equal(buildProvider({ ...remote, JUHANDU_EMBED_LOCAL: "1" }, "/tmp/x")?.name, "openai-compatible");
  } finally {
    console.warn = warn;
  }
});

test("the setup picks Cogitator, a plain endpoint, or nothing", () => {
  assert.equal(buildProvider({ JUHANDU_LOCAL_AI: "off", JUHANDU_COGITATOR_URL: "http://127.0.0.1:8470" }, "/tmp/x"), null);
  assert.equal(buildProvider({ JUHANDU_COGITATOR_URL: "http://127.0.0.1:8470" }, "/tmp/x")?.name, "cogitator");
  assert.equal(buildProvider({ JUHANDU_EMBED_URL: "http://127.0.0.1:8181/v1" }, "/tmp/x")?.name, "openai-compatible");
  assert.equal(buildProvider({}, "/tmp/x"), null);
  assert.equal(buildEmbedder(null, {}), null);
  const chatOnly = buildProvider({ JUHANDU_CHAT_URL: "http://127.0.0.1:8181/v1" }, "/tmp/x");
  assert.equal(buildEmbedder(chatOnly, {}), null);
});

test("classMass folds token variants and refuses when the answer words are not in the top candidates", () => {
  const mass = classMass([{ token: " YES", logprob: Math.log(0.6) }, { token: "no", logprob: Math.log(0.2) }, { token: "maybe", logprob: Math.log(0.2) }], { yes: ["yes"], no: ["no"] });
  assert.ok(Math.abs(mass!["yes"]! - 0.75) < 1e-9);
  assert.equal(classMass([{ token: "maybe", logprob: -0.1 }], { yes: ["yes"], no: ["no"] }), null);
  assert.equal(classMass(undefined, { yes: ["yes"] }), null);
});

/** The same judging contract must hold through every adapter: Cogitator and the generic OpenAI-style one. */
const adapters: [string, (fetchImpl: FetchLike) => ModelProvider][] = [
  ["cogitator", (f) => cogitator(f)],
  ["openai-compatible", (f) => generic(f)],
];

for (const [name, make] of adapters) {
  test(`${name}: the judge reads a calibrated yes/no from first-token probabilities and logs it`, async () => {
    const store = new Store(":memory:");
    const calls: Call[] = [];
    const judge = new LlmJudge({ provider: make(fakeHost(calls, { yesProbability: 0.8 }, name === "cogitator")), onJudgment: (entry) => store.logJudgment(entry) });
    const verdict = await judge.yesNo({ question: "Is this item about Rust?", facts: { title: "Rust 2027 edition" } }, { tier: "public", priority: "background" });
    assert.equal(verdict.answer, true);
    assert.equal(verdict.calibrated, true);
    assert.ok(Math.abs(verdict.probability - 0.8) < 1e-9);
    assert.equal(calls[0]!.body["logprobs"], true);
    assert.equal(calls[0]!.body["temperature"], 0);
    const logged = store.recentJudgments();
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.kind, "yes_no");
    assert.equal(logged[0]!.provider, name);
    assert.equal(logged[0]!.model, name === "cogitator" ? "gemma-4-12b" : "any-chat");
    store.close();
  });

  test(`${name}: pickOne gives per-option probabilities and rank validates the order`, async () => {
    const calls: Call[] = [];
    const options = [
      { id: "x", facts: { name: "first" } },
      { id: "y", facts: { name: "second" } },
    ];
    const pick = await new LlmJudge({ provider: make(fakeHost(calls, {}, name === "cogitator")) }).pickOne({ question: "Which is better?", options }, { tier: "public", priority: "interactive" });
    assert.equal(pick.id, "x");
    assert.ok(Math.abs(pick.probabilities["x"]! - 0.7) < 1e-9);
    assert.equal(calls[0]!.body["top_logprobs"], 20);
    const ranker = new LlmJudge({ provider: make(fakeHost(calls, { chatText: JSON.stringify({ order: ["y", "x"] }) }, name === "cogitator")) });
    assert.deepEqual((await ranker.rank({ question: "Rank them", options }, { tier: "public", priority: "background" })).order, ["y", "x"]);
    assert.equal(calls.at(-1)!.body["response_format"].type, "json_schema");
    const bad = new LlmJudge({ provider: make(fakeHost(calls, { chatText: JSON.stringify({ order: ["y", "y"] }) }, name === "cogitator")) });
    await assert.rejects(bad.rank({ question: "Rank them", options }, { tier: "public", priority: "background" }), JudgeError);
  });
}

test("a judge without log-probabilities falls back to the parsed answer, flagged uncalibrated", async () => {
  const reply = (content: string): FetchLike => async (url) => (url.includes("discovery") ? new Response(JSON.stringify(DISCOVERY), { status: 200 }) : new Response(JSON.stringify({ model: "m", choices: [{ message: { content } }] }), { status: 200 }));
  const noProbs = reply("No.");
  const verdict = await new LlmJudge({ provider: cogitator(noProbs) }).yesNo({ question: "q", facts: {} }, { tier: "public", priority: "background" });
  assert.deepEqual({ answer: verdict.answer, probability: verdict.probability, calibrated: verdict.calibrated }, { answer: false, probability: 0, calibrated: false });
  const vague = reply("It depends.");
  await assert.rejects(new LlmJudge({ provider: cogitator(vague) }).yesNo({ question: "q", facts: {} }, { tier: "public", priority: "background" }), JudgeError);
});

test("judge calls switch thinking off through Cogitator, and only add extra fields on a plain endpoint when configured", async () => {
  const calls: Call[] = [];
  const request: ChatRequest = { job: "judge", tier: "public", priority: "background", messages: [{ role: "user", content: "hi" }], thinking: false };
  await cogitator(fakeHost(calls)).chat(request);
  assert.deepEqual(calls[0]!.body["chat_template_kwargs"], { enable_thinking: false });
  calls.length = 0;
  await generic(fakeHost(calls, {}, false)).chat(request);
  assert.equal("chat_template_kwargs" in calls[0]!.body, false);
  const endpoint: OpenAIEndpoint = { name: "chat", baseUrl: "http://plain.test/v1", model: "m", local: true, extraBody: { chat_template_kwargs: { enable_thinking: false } } };
  const configured = new OpenAICompatibleProvider({ chatPool: new EndpointPool([endpoint], new EgressGate()), fetchImpl: fakeHost(calls, {}, false) });
  calls.length = 0;
  await configured.chat(request);
  assert.deepEqual(calls[0]!.body["chat_template_kwargs"], { enable_thinking: false });
});

test("a sentence drafted from private items is embedded at the private tier, and the default stays public", async () => {
  const tiers: string[] = [];
  const provider = {
    embeddingModel: async () => "embed",
    embed: async (request: { tier: string; texts: string[] }) => {
      tiers.push(request.tier);
      return { model: "embed", vectors: request.texts.map(() => new Float32Array([1, 0])) };
    },
  } as unknown as ModelProvider;
  const embedder = new Embedder({ provider });
  await embedder.queries("background", ["a rule"]);
  await embedder.queries("background", ["a rule drafted from private votes"], "private");
  assert.deepEqual(tiers, ["public", "private"]);
});

test("Cogitator's discovery file is looked for in its home, then on D:, then in the older per-user folder, and only Windows adds the last two", () => {
  const win = { LOCALAPPDATA: "C:/Users/me/AppData/Local" };
  const [onD, perUser] = discoveryCandidates(win);
  assert.match(onD ?? "", /^D:.Cogitator.data.discovery\.json$/);
  assert.match(perUser ?? "", /Cogitator.data.discovery\.json$/);
  assert.deepEqual(discoveryCandidates({}), [], "no Windows marker and no home setting means nothing to look for");
  const withHome = discoveryCandidates({ ...win, JUHANDU_COGITATOR_HOME: "E:/Models/Cogitator" });
  assert.equal(withHome.length, 3);
  assert.match(withHome[0] ?? "", /E:.Models.Cogitator.data.discovery\.json$/);
  assert.equal(discoveryCandidates({ JUHANDU_COGITATOR_HOME: "/opt/cogitator" }).length, 1, "the home setting works off Windows too");

  const present = new Set([perUser]);
  assert.equal(defaultDiscoveryFile(win, (path) => present.has(path)), perUser, "an existing older file is still found");
  present.add(onD);
  assert.equal(defaultDiscoveryFile(win, (path) => present.has(path)), onD, "D: wins once its file exists");
  assert.equal(defaultDiscoveryFile(win, () => false), onD, "with nothing present the preferred path is the one reported");
  assert.equal(defaultDiscoveryFile({}, () => true), undefined);
});
