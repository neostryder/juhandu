import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import type { Judge } from "../src/judges/judge.ts";
import { PipeEngine } from "../src/pipes/engine.ts";
import { parsePipeDoc, slugify } from "../src/pipes/pipe.ts";
import type { PipeDoc, PipeStep } from "../src/pipes/pipe.ts";
import { renderAtom } from "../src/pipes/feed.ts";
import { Store } from "../src/store/store.ts";
import type { DataTier, NewItem } from "../src/store/store.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";

function item(n: number, title: string, extra: Partial<NewItem> = {}): NewItem {
  const day = String(10 + n).padStart(2, "0");
  return { guid: `g${n}-${title}`, url: `https://site.example/${n}`, title, author: "", publishedAt: `2026-09-${day}T12:00:00Z`, summaryText: `Text of ${title}`, contentHtml: "", image: "", titleHash: `h${n}-${title}`, extra: {}, ...extra };
}

interface World {
  store: Store;
  ai: number;
  ids: { ai1: number; ai2: number; music: number; secret: number };
}

function world(): World {
  const store = new Store(":memory:");
  const add = (key: string, folder: string, tier: DataTier = "public") => store.addSource({ kind: "feed", url: `https://${key}.example/feed`, title: key.toUpperCase(), folder, tier }).id;
  const ids = { ai1: add("ai1", "AI"), ai2: add("ai2", "AI"), music: add("music", "Music"), secret: add("secret", "Work", "private") };
  store.upsertItems(ids.ai1, [item(1, "New model released"), item(2, "Weekly roundup"), item(3, "Sponsored: buy now")]);
  store.upsertItems(ids.ai2, [item(4, "New model released", { url: "https://other.example/4" }), item(5, "Paper on agents")]);
  store.upsertItems(ids.music, [item(6, "Album review"), item(7, "Tour dates")]);
  store.upsertItems(ids.secret, [item(8, "Internal memo")]);
  return { store, ai: ids.ai1, ids };
}

const doc = (steps: PipeStep[], inputs: PipeDoc["inputs"] = [{ kind: "all" }], output: Partial<PipeDoc["output"]> = {}): PipeDoc => ({ version: 1, inputs, steps, output: { limit: 100, publish: false, ...output } });
const titles = (r: { entries: { title: string }[] }): string[] => r.entries.map((e) => e.title);

test("parsePipeDoc normalizes a document and explains what is wrong with a bad one", () => {
  const ok = parsePipeDoc({ inputs: [{ kind: "folder", name: "AI" }], steps: [{ op: "filter", conditions: [{ field: "title", test: "contains", value: "model" }] }, { op: "sort" }, { op: "summary" }] });
  assert.equal(ok.output.limit, 100);
  assert.deepEqual(ok.steps[0], { op: "filter", keep: true, match: "any", conditions: [{ field: "title", test: "contains", value: "model" }] });
  assert.deepEqual(ok.steps[1], { op: "sort", by: "date", order: "desc" });
  assert.throws(() => parsePipeDoc({ inputs: [], steps: [] }), /at least one input/);
  assert.throws(() => parsePipeDoc({ inputs: [{ kind: "all" }], steps: [{ op: "filter", conditions: [] }] }), /at least one condition/);
  assert.throws(() => parsePipeDoc({ inputs: [{ kind: "all" }], steps: [{ op: "filter", conditions: [{ field: "title", test: "regex", value: "(" }] }] }), /not a valid regular expression/);
  assert.throws(() => parsePipeDoc({ inputs: [{ kind: "all" }], steps: [{ op: "explode" }] }), /kind must be one of/);
  assert.throws(() => parsePipeDoc({ inputs: [{ kind: "all" }], steps: [{ op: "limit", count: 0 }] }), /whole number/);
  assert.throws(() => parsePipeDoc({ inputs: [{ kind: "feed" }], steps: [] }), /The feed/);
  const four = Array.from({ length: 4 }, () => ({ op: "ask", question: "Is it good?" }));
  assert.throws(() => parsePipeDoc({ inputs: [{ kind: "all" }], steps: four }), /at most 3 questions/);
  assert.equal(slugify("My AI news! (v2)"), "my-ai-news-v2");
  assert.equal(slugify("   "), "pipe");
});

test("inputs: everything, a folder, one feed and a missing feed", () => {
  const w = world();
  const engine = new PipeEngine({ store: w.store });
  assert.equal(engine.evaluate(doc([])).counts.gathered, 8);
  assert.deepEqual(titles(engine.evaluate(doc([], [{ kind: "folder", name: "Music" }]))).sort(), ["Album review", "Tour dates"]);
  assert.equal(engine.evaluate(doc([], [{ kind: "folder", name: "AI" }])).entries.length, 5);
  assert.deepEqual(titles(engine.evaluate(doc([], [{ kind: "feed", id: w.ids.music }]))), ["Tour dates", "Album review"], "newest first");
  const missing = engine.evaluate(doc([], [{ kind: "feed", id: 999 }, { kind: "folder", name: "Nope" }]));
  assert.equal(missing.entries.length, 0);
  assert.equal(missing.notes.length, 2);
  w.store.close();
});

test("an item hidden by a rule stays out of every pipe", () => {
  const w = world();
  const engine = new PipeEngine({ store: w.store });
  const hidden = w.store.listItems({ limit: 50 }).find((i) => i.title === "Sponsored: buy now");
  assert.ok(hidden);
  w.store.saveDecision(hidden.id, { verdict: "hide", hideReason: "block", pinned: false, score: -9, taste: null, hits: [], incomplete: false });
  assert.equal(titles(engine.evaluate(doc([]))).includes("Sponsored: buy now"), false);
  w.store.close();
});

test("filter keeps or drops, matches any or all, and tests every field kind", () => {
  const w = world();
  const engine = new PipeEngine({ store: w.store });
  const f = (keep: boolean, match: "any" | "all", conditions: { field: any; test: any; value: string }[]): PipeStep => ({ op: "filter", keep, match, conditions });
  assert.deepEqual(titles(engine.evaluate(doc([f(false, "any", [{ field: "title", test: "starts-with", value: "sponsored" }])], [{ kind: "folder", name: "AI" }]))).sort(), ["New model released", "New model released", "Paper on agents", "Weekly roundup"]);
  assert.deepEqual(titles(engine.evaluate(doc([f(true, "all", [{ field: "title", test: "contains", value: "model" }, { field: "source", test: "equals", value: "ai2" }])]))), ["New model released"]);
  assert.equal(engine.evaluate(doc([f(true, "any", [{ field: "title", test: "regex", value: "^(album|tour)" }])])).entries.length, 2);
  assert.equal(engine.evaluate(doc([f(true, "any", [{ field: "folder", test: "equals", value: "work" }])])).entries.length, 1);
  assert.equal(engine.evaluate(doc([f(true, "any", [{ field: "text", test: "contains", value: "text of tour" }])])).entries.length, 1);
  assert.equal(engine.evaluate(doc([f(true, "any", [{ field: "url", test: "contains", value: "other.example" }])])).entries.length, 1);
  assert.equal(engine.evaluate(doc([f(true, "any", [{ field: "title", test: "not-contains", value: "e" }])])).entries.length, 0, "every title has an e");
  w.store.close();
});

test("dedupe, sort, limit and newer-than", () => {
  const w = world();
  const engine = new PipeEngine({ store: w.store });
  const ai = [{ kind: "folder", name: "AI" }] as PipeDoc["inputs"];
  assert.equal(engine.evaluate(doc([{ op: "dedupe", by: "title" }], ai)).entries.length, 4, "the same headline in two feeds counts once");
  assert.equal(engine.evaluate(doc([{ op: "dedupe", by: "url" }], ai)).entries.length, 5, "their links differ");
  assert.deepEqual(titles(engine.evaluate(doc([{ op: "sort", by: "title", order: "asc" }], [{ kind: "folder", name: "Music" }]))), ["Album review", "Tour dates"]);
  assert.deepEqual(titles(engine.evaluate(doc([{ op: "sort", by: "date", order: "asc" }], [{ kind: "folder", name: "Music" }]))), ["Album review", "Tour dates"]);
  assert.equal(engine.evaluate(doc([{ op: "limit", count: 2, perSource: false }], ai)).entries.length, 2);
  assert.equal(engine.evaluate(doc([{ op: "limit", count: 1, perSource: true }], ai)).entries.length, 2, "one per feed, two feeds");
  assert.equal(engine.evaluate(doc([{ op: "newer-than", days: 1 }])).entries.length, 0, "the sample items are weeks old");
  assert.equal(engine.evaluate(doc([{ op: "newer-than", days: 3650 }])).entries.length, 8);
  assert.equal(engine.evaluate(doc([], [{ kind: "all" }], { limit: 3 })).entries.length, 3, "the output limit applies last");
  w.store.close();
});

test("rewrite, tag and summary steps change the output and not the stored items", () => {
  const w = world();
  const engine = new PipeEngine({ store: w.store });
  const music = [{ kind: "folder", name: "Music" }] as PipeDoc["inputs"];
  const plain = engine.evaluate(doc([{ op: "rewrite", field: "title", find: "REVIEW", replace: "$&!", regex: false }], music));
  assert.ok(titles(plain).includes("Album $&!"), "a plain find is case-insensitive and the replacement is literal");
  const regex = engine.evaluate(doc([{ op: "rewrite", field: "title", find: "^(\\w+) (\\w+)$", replace: "$2: $1", regex: true }], music));
  assert.deepEqual(titles(regex).sort(), ["dates: Tour", "review: Album"]);
  const url = engine.evaluate(doc([{ op: "rewrite", field: "url", find: "https://", replace: "ftp://", regex: false }], music));
  assert.ok(url.entries.every((e) => e.url.startsWith("https://")), "a link that stops being http is left alone");
  assert.ok(url.notes.some((n) => /http/.test(n)));
  const tagged = engine.evaluate(doc([{ op: "tag", tag: "listen" }, { op: "tag", tag: "listen" }, { op: "filter", keep: true, match: "any", conditions: [{ field: "tag", test: "equals", value: "listen" }] }], music));
  assert.equal(tagged.entries.length, 2);
  assert.deepEqual(tagged.entries[0]?.tags, ["listen"]);
  const stored = w.store.listItems({ limit: 50 }).find((i) => i.title === "Album review");
  assert.ok(stored, "the original keeps its title");
  w.store.saveSummary(stored.id, { status: "ok", text: "One line.", evidence: "Text of Album review", verified: true, model: "m", promptVersion: 1 });
  const summed = engine.evaluate(doc([{ op: "summary" }], music));
  assert.equal(summed.entries.find((e) => e.title === "Album review")?.text, "One line.");
  assert.equal(summed.entries.find((e) => e.title === "Tour dates")?.text, "Text of Tour dates", "an item with no summary keeps its text");
  w.store.close();
});

test("a pipe can read another pipe, and a loop is refused", () => {
  const w = world();
  const engine = new PipeEngine({ store: w.store });
  const a = w.store.addPipe({ slug: "a", name: "A", doc: doc([{ op: "filter", keep: true, match: "any", conditions: [{ field: "title", test: "contains", value: "model" }] }], [{ kind: "folder", name: "AI" }]) });
  const b = w.store.addPipe({ slug: "b", name: "B", doc: doc([{ op: "dedupe", by: "title" }], [{ kind: "pipe", id: a.id }, { kind: "folder", name: "Music" }]) });
  assert.deepEqual(titles(engine.evaluate(b.doc)).sort(), ["Album review", "New model released", "Tour dates"]);
  assert.deepEqual(engine.usedBy(a.id), [b.id]);
  assert.equal(engine.wouldLoop(a.id, doc([], [{ kind: "pipe", id: b.id }])), true, "A reading B, which reads A");
  assert.equal(engine.wouldLoop(a.id, doc([], [{ kind: "pipe", id: a.id }])), true, "a pipe reading itself");
  assert.equal(engine.wouldLoop(b.id, doc([], [{ kind: "pipe", id: a.id }])), false);
  assert.equal(engine.wouldLoop(null, doc([], [{ kind: "pipe", id: a.id }])), false);
  w.store.updatePipe(a.id, { doc: doc([], [{ kind: "pipe", id: b.id }]) });
  assert.throws(() => engine.evaluate(w.store.getPipe(b.id)?.doc as PipeDoc, { stack: [b.id] }), /reading itself|reads itself/, "a loop that got into the store still cannot run forever");
  w.store.close();
});

test("a pipe that reads a private feed is private, through other pipes too", () => {
  const w = world();
  const engine = new PipeEngine({ store: w.store });
  assert.equal(engine.tierOf(doc([], [{ kind: "folder", name: "AI" }])), "public");
  assert.equal(engine.tierOf(doc([], [{ kind: "all" }])), "private");
  assert.equal(engine.tierOf(doc([], [{ kind: "feed", id: w.ids.secret }])), "private");
  const inner = w.store.addPipe({ slug: "inner", name: "Inner", doc: doc([], [{ kind: "folder", name: "Work" }]) });
  assert.equal(engine.tierOf(doc([], [{ kind: "pipe", id: inner.id }])), "private");
  assert.equal(engine.evaluate(doc([], [{ kind: "pipe", id: inner.id }])).tier, "private");
  w.store.close();
});

class FakeJudge implements Judge {
  asked: { title: string; tier: DataTier }[] = [];
  offline = false;
  async yesNo(q: { question: string; facts: Record<string, string | number | boolean> }, ctx: { tier: DataTier }) {
    if (this.offline) throw new Error("boom");
    this.asked.push({ title: String(q.facts["title"]), tier: ctx.tier });
    return { answer: /model|agents/i.test(String(q.facts["title"])), probability: 0.9, calibrated: true, model: "fake" };
  }
  async pickOne(): Promise<never> {
    throw new Error("not used");
  }
  async rank(): Promise<never> {
    throw new Error("not used");
  }
}

test("a question for the AI holds items back until the background pass answers them", async () => {
  const w = world();
  const judge = new FakeJudge();
  const engine = new PipeEngine({ store: w.store, judge });
  const question = "Is this about AI research or products?";
  const pipe = w.store.addPipe({ slug: "q", name: "Q", doc: doc([{ op: "limit", count: 100, perSource: false }, { op: "ask", question, keep: "yes" }], [{ kind: "folder", name: "AI" }]) });
  const before = engine.evaluate(pipe.doc);
  assert.equal(before.entries.length, 0, "nothing is shown before it has been asked");
  assert.equal(before.counts.waiting, 5);
  assert.ok(before.notes.some((n) => /waiting for the AI/.test(n)));

  const first = await engine.runAsks("background", 3);
  assert.equal(first.answered, 3);
  assert.equal(first.queued, 2);
  const rest = await engine.runAsks("background", 10);
  assert.equal(rest.answered, 2);
  assert.equal(judge.asked.length, 5);
  assert.ok(judge.asked.every((a) => a.tier === "public"));
  const after = engine.evaluate(pipe.doc);
  assert.deepEqual(titles(after).sort(), ["New model released", "New model released", "Paper on agents"]);
  assert.equal(after.counts.waiting, 0);
  assert.equal((await engine.runAsks("background")).answered, 0, "answers are kept, nothing is asked twice");

  const no = engine.evaluate({ ...pipe.doc, steps: [{ op: "ask", question, keep: "no" }] });
  assert.deepEqual(titles(no).sort(), ["Sponsored: buy now", "Weekly roundup"]);
  w.store.close();
});

test("a private feed's text is asked about as private, and no model means the question waits", async () => {
  const w = world();
  const judge = new FakeJudge();
  const engine = new PipeEngine({ store: w.store, judge });
  const pipe = w.store.addPipe({ slug: "p", name: "P", doc: doc([{ op: "ask", question: "Is it a memo?", keep: "yes" }], [{ kind: "folder", name: "Work" }]) });
  await engine.runAsks("background");
  assert.deepEqual(judge.asked, [{ title: "Internal memo", tier: "private" }]);
  judge.offline = true;
  const other = w.store.addPipe({ slug: "o", name: "O", doc: doc([{ op: "ask", question: "Another question?", keep: "yes" }], [{ kind: "folder", name: "Music" }]) });
  const failed = await engine.runAsks("background");
  assert.equal(failed.failed, 2);
  const noModel = new PipeEngine({ store: w.store });
  const run = noModel.evaluate(other.doc);
  assert.ok(run.notes.some((n) => /waits until a model is available/.test(n)));
  assert.equal((await noModel.runAsks("background")).answered, 0);
  void pipe;
  w.store.close();
});

test("renderAtom escapes text, drops bad characters and keeps tags", () => {
  const xml = renderAtom({ slug: "s", name: "A & B <feed>" }, [{ itemId: 1, sourceId: 1, source: "Src \"q\"", folder: "", url: "https://x.example/?a=1&b=2", title: "Hi <b>there</b>\u0001", author: "Ann", text: "t", summary: "line & more", publishedAt: null, at: "2026-09-11T12:00:00Z", tags: ["x&y"], tier: "public" }], new Date("2026-10-01T00:00:00Z"));
  assert.ok(xml.includes("<title>A &amp; B &lt;feed&gt;</title>"));
  assert.ok(xml.includes("<title>Hi &lt;b&gt;there&lt;/b&gt;</title>"));
  assert.ok(xml.includes('<link href="https://x.example/?a=1&amp;b=2"/>'));
  assert.ok(xml.includes('<category term="x&amp;y"/>'));
  assert.ok(xml.includes("<summary type=\"text\">line &amp; more</summary>"));
  assert.ok(!xml.includes("\u0001"));
});

async function rig() {
  const store = new Store(":memory:");
  const w = { store };
  const fetchImpl: FetchLike = async () => {
    throw new Error("pipes never fetch");
  };
  const server = createApp({ store, ingestor: new Ingestor(store, fetchImpl), fetchImpl, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    ...w,
    call: (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

test("the pipes API creates, previews, updates, serves a feed and refuses unsafe changes", async () => {
  const r = await rig();
  try {
    const feed = r.store.addSource({ kind: "feed", url: "https://ai.example/feed", title: "AI", folder: "AI", tier: "public" });
    r.store.upsertItems(feed.id, [item(1, "One model"), item(2, "Two")]);
    const priv = r.store.addSource({ kind: "feed", url: "https://sec.example/feed", title: "Sec", folder: "Work", tier: "private" });
    r.store.upsertItems(priv.id, [item(3, "Memo")]);

    assert.equal((await r.call("POST", "/api/pipes", { doc: doc([]) })).status, 400, "a name is required");
    assert.equal((await r.call("POST", "/api/pipes", { name: "Bad", doc: { inputs: [] } })).status, 422);
    const made = await r.call("POST", "/api/pipes", { name: "AI Only", doc: doc([{ op: "tag", tag: "ai" }], [{ kind: "folder", name: "AI" }], { publish: true }) });
    assert.equal(made.status, 201);
    const { pipe } = (await made.json()) as { pipe: { id: number; slug: string; tier: string; feedPath: string } };
    assert.equal(pipe.slug, "ai-only");
    assert.equal(pipe.tier, "public");
    assert.equal(pipe.feedPath, "/pipes/ai-only.xml");
    const twin = (await (await r.call("POST", "/api/pipes", { name: "AI Only", doc: doc([]) })).json()) as { pipe: { slug: string } };
    assert.equal(twin.pipe.slug, "ai-only-2", "a second pipe with the same name gets its own address");

    const preview = (await (await r.call("POST", "/api/pipes/preview", { doc: doc([{ op: "filter", keep: true, match: "any", conditions: [{ field: "title", test: "contains", value: "model" }] }], [{ kind: "folder", name: "AI" }]) })).json()) as { entries: { title: string }[]; counts: { gathered: number } };
    assert.deepEqual(preview.entries.map((e) => e.title), ["One model"]);
    assert.equal(preview.counts.gathered, 2);
    const items = (await (await r.call("GET", `/api/pipes/${pipe.id}/items`)).json()) as { entries: { tags: string[] }[] };
    assert.deepEqual(items.entries[0]?.tags, ["ai"]);

    const xml = await r.call("GET", "/pipes/ai-only.xml");
    assert.equal(xml.status, 200);
    assert.match(xml.headers.get("content-type") ?? "", /atom\+xml/);
    const body = await xml.text();
    assert.ok(body.includes("<title>One model</title>") && body.includes('<category term="ai"/>'));
    assert.equal((await r.call("GET", "/pipes/ai-only-2.xml")).status, 404, "an unpublished pipe has no feed");
    assert.equal((await r.call("GET", "/pipes/nothing.xml")).status, 404);

    const leak = await r.call("PUT", `/api/pipes/${pipe.id}`, { doc: doc([], [{ kind: "feed", id: priv.id }], { publish: true }) });
    assert.equal(leak.status, 422, "a pipe that reads a private feed cannot be published");
    assert.equal((await r.call("POST", "/api/pipes", { name: "Leak", doc: doc([], [{ kind: "all" }], { publish: true }) })).status, 422);
    const kept = await r.call("PUT", `/api/pipes/${pipe.id}`, { name: "Renamed", doc: doc([], [{ kind: "feed", id: priv.id }]) });
    assert.equal(kept.status, 200);
    assert.equal(((await kept.json()) as { pipe: { tier: string } }).pipe.tier, "private");
    assert.equal((await r.call("GET", "/pipes/ai-only.xml")).status, 404, "turning publishing off turns the feed off");

    const second = twin.pipe as unknown as { id?: number };
    const all = (await (await r.call("GET", "/api/pipes")).json()) as { pipes: { id: number; name: string }[] };
    const secondId = all.pipes.find((p) => p.name === "AI Only")?.id as number;
    assert.ok(secondId && second);
    assert.equal((await r.call("PUT", `/api/pipes/${secondId}`, { doc: doc([], [{ kind: "pipe", id: pipe.id }]) })).status, 200);
    assert.equal((await r.call("PUT", `/api/pipes/${pipe.id}`, { doc: doc([], [{ kind: "pipe", id: secondId }]) })).status, 422, "a loop is refused");
    assert.equal((await r.call("DELETE", `/api/pipes/${pipe.id}`)).status, 409, "a pipe another pipe reads cannot be deleted");
    assert.equal((await r.call("DELETE", `/api/pipes/${secondId}`)).status, 200);
    assert.equal((await r.call("DELETE", `/api/pipes/${pipe.id}`)).status, 200);
    assert.equal((await r.call("GET", `/api/pipes/${pipe.id}`)).status, 404);
  } finally {
    await r.close();
  }
});
