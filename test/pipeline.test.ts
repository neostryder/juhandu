import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { EgressGate } from "../src/models/egress.ts";
import { Embedder } from "../src/models/embedder.ts";
import { OpenAICompatibleProvider } from "../src/models/generic.ts";
import { embedWith } from "../src/models/openai.ts";
import type { OpenAIEndpoint } from "../src/models/openai.ts";
import { ClientError, EndpointPool, NoEndpointError } from "../src/models/pool.ts";
import { Processor } from "../src/pipeline/process.ts";
import { Store } from "../src/store/store.ts";
import type { NewItem } from "../src/store/store.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";

function item(guid: string, title: string, text = ""): NewItem {
  return { guid, url: `https://x.example/${guid}`, title, author: "", publishedAt: "2026-10-06T08:00:00Z", summaryText: text, contentHtml: "", image: "", titleHash: guid, extra: {} };
}

/** A fake OpenAI-style embeddings server: vectors are a bag of three topics. */
function embeddingsFetch(log: string[] = []): FetchLike {
  const topic = (t: string): number[] => {
    const lower = t.toLowerCase();
    return [lower.includes("rust") ? 1 : 0.01, lower.includes("recipe") ? 1 : 0.01, lower.includes("sponsored") ? 1 : 0.01];
  };
  return async (url, init) => {
    log.push(url);
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: body.input.map((t, index) => ({ index, embedding: topic(t) })) }), { status: 200 });
  };
}

function endpoint(name: string, local: boolean, extra: Partial<OpenAIEndpoint> = {}): OpenAIEndpoint {
  return { name, baseUrl: `http://${name}.test/v1`, model: "m", local, ...extra };
}

function embedderFor(pool: EndpointPool<OpenAIEndpoint>, fetchImpl: FetchLike): Embedder {
  return new Embedder({ provider: new OpenAICompatibleProvider({ embedPool: pool, embedTag: "test-model", fetchImpl }) });
}

test("the pool fails over, skips a down endpoint briefly, and never fails over on a client error", async () => {
  let now = 1_000;
  const pool = new EndpointPool([endpoint("a", true), endpoint("b", true)], new EgressGate(), () => now);
  const calls: string[] = [];
  const result = await pool.run("public", async (e) => {
    calls.push(e.name);
    if (e.name === "a") throw new Error("down");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(calls, ["a", "b"]);
  calls.length = 0;
  await pool.run("public", async (e) => {
    calls.push(e.name);
    return "ok";
  });
  assert.deepEqual(calls, ["b"]);
  now += 31_000;
  calls.length = 0;
  await pool.run("public", async (e) => {
    calls.push(e.name);
    return "ok";
  });
  assert.deepEqual(calls, ["a"]);
  await assert.rejects(
    pool.run("public", async () => {
      throw new ClientError(400, "bad request");
    }),
    ClientError,
  );
});

test("the egress gate keeps private data off hosted endpoints unless the owner allowed them", async () => {
  const hosted = endpoint("hosted", false);
  const local = endpoint("local", true);
  const strict = new EndpointPool([hosted], new EgressGate());
  await assert.rejects(strict.run("private", async () => "x"), NoEndpointError);
  assert.equal(await strict.run("public", async () => "x"), "x");
  const mixed = new EndpointPool([hosted, local], new EgressGate());
  assert.equal(await mixed.run("private", async (e) => e.name), "local");
  const allowed = new EndpointPool([hosted], new EgressGate(["hosted"]));
  assert.equal(await allowed.run("private", async (e) => e.name), "hosted");
});

test("embedWith reads OpenAI-style responses in index order and maps statuses", async () => {
  const reordered: FetchLike = async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
  const vectors = await embedWith(endpoint("e", true), ["a", "b"], reordered);
  assert.deepEqual(Array.from(vectors[0]!), [1, 0]);
  await assert.rejects(embedWith(endpoint("e", true), ["a"], async () => new Response("no", { status: 401 })), ClientError);
  await assert.rejects(embedWith(endpoint("e", true), ["a"], async () => new Response("no", { status: 503 })), /503/);
});

test("the processor embeds items, applies rules, and records taste in shadow", async () => {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed", folder: "Tech" });
  store.upsertItems(source.id, [item("1", "Rust 2027 edition announced", "language news"), item("2", "Best recipe for lentil soup"), item("3", "Sponsored: top ten gadgets")]);
  const pool = new EndpointPool([endpoint("local", true)], new EgressGate());
  const embedder = embedderFor(pool, embeddingsFetch());
  const processor = new Processor(store, embedder);

  store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "keyword", terms: ["sponsored"], mode: "any", fields: ["title"] } });
  const first = await processor.run();
  assert.equal(first.embedded, 3);
  assert.equal(first.decided, 3);
  assert.equal(store.listItems({ view: "filtered" }).length, 1);
  assert.equal(store.listItems({ view: "inbox" }).length, 2);
  const hidden = store.listItems({ view: "filtered" })[0]!;
  assert.equal(hidden.decision!.hits[0]!.kind, "block");

  const rust = store.listItems().find((i) => i.title.startsWith("Rust"))!;
  store.setVote(rust.id, 1, "I follow Rust closely");
  store.addRule({ kind: "weight", scope: { type: "all" }, weight: 0.1, condition: { type: "keyword", terms: ["rust"], mode: "any", fields: ["title"] } });
  await processor.run();
  const after = store.listItems();
  const rustAfter = after.find((i) => i.id === rust.id)!;
  const soup = after.find((i) => i.title.includes("soup"))!;
  assert.equal(rustAfter.vote, 1);
  assert.equal(rustAfter.voteReason, "I follow Rust closely");
  assert.ok(rustAfter.decision!.taste! > soup.decision!.taste!);
  store.close();
});

test("a semantic rule hides on similarity and counter-examples protect near misses", async () => {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed" });
  store.upsertItems(source.id, [item("1", "Sponsored roundup of gadgets"), item("2", "Rust and recipe night")]);
  const embedder = embedderFor(new EndpointPool([endpoint("local", true)], new EgressGate()), embeddingsFetch());
  const processor = new Processor(store, embedder);
  store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "semantic", sentence: "sponsored posts", examples: [], counterExamples: [], threshold: 0.7 } });
  await processor.run();
  const byTitle = Object.fromEntries(store.listItems().map((i) => [i.title, i.decision!.verdict]));
  assert.equal(byTitle["Sponsored roundup of gadgets"], "hide");
  assert.equal(byTitle["Rust and recipe night"], "show");
  store.close();
});

test("with no endpoint the work queues, nothing is dropped, and a later run catches up", async () => {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed" });
  store.upsertItems(source.id, [item("1", "Rust news")]);
  let up = false;
  const fetchImpl: FetchLike = async (url, init) => {
    if (!up) throw new Error("connection refused");
    return embeddingsFetch()(url, init);
  };
  let now = 0;
  const pool = new EndpointPool([endpoint("local", true)], new EgressGate(), () => now);
  const processor = new Processor(store, embedderFor(pool, fetchImpl));
  store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "semantic", sentence: "rust", examples: [], counterExamples: [], threshold: 0.9 } });
  const down = await processor.run();
  assert.equal(down.embedded, 0);
  assert.equal(down.queued, 1);
  assert.equal(store.listItems({ view: "inbox" }).length, 1);
  assert.equal(store.listItems()[0]!.decision!.incomplete, true);
  up = true;
  now += 31_000;
  const recovered = await processor.run();
  assert.equal(recovered.embedded, 1);
  assert.equal(store.listItems({ view: "filtered" }).length, 1);
  assert.equal(store.listItems()[0]!.decision!.incomplete, false);
  store.close();
});

test("a changed rule re-judges old items and a restored item stays visible", async () => {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed" });
  store.upsertItems(source.id, [item("1", "Daily gossip digest")]);
  const processor = new Processor(store, null);
  await processor.run();
  assert.equal(store.listItems({ view: "filtered" }).length, 0);
  const rule = store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "keyword", terms: ["gossip"], mode: "any", fields: ["title"] } });
  await processor.run();
  const hidden = store.listItems({ view: "filtered" });
  assert.equal(hidden.length, 1);
  assert.equal(store.restoreItem(hidden[0]!.id), true);
  assert.equal(store.listItems({ view: "filtered" }).length, 0);
  assert.equal(store.listItems({ view: "inbox" }).length, 1);
  store.updateRule(rule.id, { condition: { type: "keyword", terms: ["gossip digest"], mode: "any", fields: ["title"] } });
  await processor.run();
  assert.equal(store.listItems({ view: "inbox" }).length, 1);
  store.close();
});

test("the HTTP API creates rules, validates them, records votes and serves the filtered view", async () => {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed" });
  store.upsertItems(source.id, [item("1", "Celebrity gossip tonight"), item("2", "Compiler internals")]);
  const processor = new Processor(store, null);
  const server = createApp({ store, ingestor: new Ingestor(store), processor, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: (await response.json()) as Record<string, any> };
  };

  const bad = await call("POST", "/api/rules", { kind: "block", condition: { type: "regex", pattern: "([", flags: "i", fields: ["title"] } });
  assert.equal(bad.status, 422);
  const created = await call("POST", "/api/rules", { kind: "block", scope: { type: "all" }, condition: { type: "keyword", terms: ["gossip"], mode: "any", fields: ["title"] }, note: "no tabloids" });
  assert.equal(created.status, 201);
  const filtered = await call("GET", "/api/items?view=filtered");
  assert.equal(filtered.json["items"].length, 1);
  assert.equal(filtered.json["items"][0].decision.hits[0].ruleId, created.json["rule"].id);
  const inbox = await call("GET", "/api/items?view=inbox");
  assert.equal(inbox.json["items"].length, 1);

  const kept = inbox.json["items"][0];
  assert.equal((await call("POST", `/api/items/${kept.id}/vote`, { vote: 1, reason: "good" })).status, 200);
  assert.equal((await call("POST", `/api/items/${kept.id}/vote`, { vote: 5 })).status, 400);
  assert.equal((await call("GET", "/api/items?view=inbox")).json["items"][0].vote, 1);

  const patched = await call("PATCH", `/api/rules/${created.json["rule"].id}`, { status: "disabled" });
  assert.equal(patched.json["rule"].status, "disabled");
  assert.equal((await call("GET", "/api/items?view=filtered")).json["items"].length, 0);
  assert.equal((await call("DELETE", `/api/rules/${created.json["rule"].id}`)).status, 200);
  assert.equal((await call("DELETE", "/api/rules/999")).status, 404);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

test("a rule preview ranks recent items by similarity and counts keyword matches", async () => {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed" });
  store.upsertItems(source.id, [item("1", "Rust 2027 edition"), item("2", "Lentil soup recipe"), item("3", "Sponsored gadgets")]);
  const embedder = embedderFor(new EndpointPool([endpoint("local", true)], new EgressGate()), embeddingsFetch());
  const processor = new Processor(store, embedder);
  await processor.run();
  const semantic = await processor.preview({ type: "semantic", sentence: "recipe ideas", examples: [], counterExamples: [], threshold: 0.9 });
  assert.equal(semantic[0]!.title, "Lentil soup recipe");
  assert.equal(semantic[0]!.matched, true);
  assert.equal(semantic.filter((r) => r.matched).length, 1);
  const keyword = await processor.preview({ type: "keyword", terms: ["rust"], mode: "any", fields: ["title"] });
  assert.equal(keyword.filter((r) => r.matched).length, 1);
  assert.equal(keyword[0]!.similarity, null);
  store.close();
});
