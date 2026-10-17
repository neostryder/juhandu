import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Processor } from "../src/pipeline/process.ts";
import { evaluateRules, validateCondition } from "../src/rules/rules.ts";
import type { RuleItem } from "../src/rules/rules.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";
import { Store } from "../src/store/store.ts";
import type { NewItem } from "../src/store/store.ts";
import { buildVideoDurations, durationFromWatchPage, NO_DURATION, parseIsoDuration, VideoDurations } from "../src/video/duration.ts";

const NOW = new Date("2026-10-16T12:00:00Z");

function video(id: string, title: string): NewItem {
  return { guid: id, url: `https://www.youtube.com/watch?v=${id}`, title, author: "", publishedAt: "2026-10-16T08:00:00Z", summaryText: "", contentHtml: "", image: "", titleHash: id, extra: {} };
}

const SHORT = "aaaaaaaaaaa";
const LONG = "bbbbbbbbbbb";
const GONE = "ccccccccccc";

/** A fake of the Data API: ids it knows get a length, the rest are left out of the answer. */
function apiFetch(lengths: Record<string, string>, calls: { url: string; key: string | null }[] = []): FetchLike {
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, key: headers.get("x-goog-api-key") });
    const ids = new URL(url).searchParams.get("id")!.split(",");
    const items = ids.filter((id) => lengths[id]).map((id) => ({ id, contentDetails: { duration: lengths[id] } }));
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
}

test("ISO 8601 durations are read to seconds and junk is refused", () => {
  assert.equal(parseIsoDuration("PT4M13S"), 253);
  assert.equal(parseIsoDuration("PT1H"), 3600);
  assert.equal(parseIsoDuration("P1DT2H"), 93_600);
  assert.equal(parseIsoDuration("PT0S"), 0);
  assert.equal(parseIsoDuration("P0D"), 0);
  assert.equal(parseIsoDuration("PT59.5S"), 60);
  for (const bad of ["", "P", "PT", "4:13", "PT-1S", "T4M"]) assert.equal(parseIsoDuration(bad), null, bad);
});

test("a watch page states its length in a meta tag or in its player data", () => {
  assert.equal(durationFromWatchPage('<meta itemprop="duration" content="PT1M30S">'), 90);
  assert.equal(durationFromWatchPage('<meta content="PT2M" itemprop="duration">'), 120);
  assert.equal(durationFromWatchPage('<script>{"videoDetails":{"lengthSeconds":"615"}}</script>'), 615);
  assert.equal(durationFromWatchPage("<html>nothing here</html>"), null);
});

test("the API path asks in batches with the key in a header, and a video it leaves out has no length", async () => {
  const calls: { url: string; key: string | null }[] = [];
  const durations = new VideoDurations({ apiKey: () => "k-test", fetchImpl: apiFetch({ [SHORT]: "PT45S", [LONG]: "PT1H2M" }, calls) });
  assert.equal(durations.mode(), "api");
  const found = await durations.lookup([SHORT, LONG, GONE, SHORT]);
  assert.equal(found.get(SHORT), 45);
  assert.equal(found.get(LONG), 3720);
  assert.equal(found.get(GONE), NO_DURATION);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.key, "k-test");
  assert.ok(!calls[0]!.url.includes("k-test"), "the key is not in the address");
});

test("a live stream (P0D) gets no length, and more than 50 ids are split across calls", async () => {
  const calls: { url: string; key: string | null }[] = [];
  const ids = Array.from({ length: 120 }, (_, i) => `v${String(i).padStart(10, "0")}`);
  const lengths: Record<string, string> = Object.fromEntries(ids.map((id) => [id, "PT5M"]));
  lengths[ids[0]!] = "P0D";
  const durations = new VideoDurations({ apiKey: () => "k", fetchImpl: apiFetch(lengths, calls) });
  const found = await durations.lookup(ids);
  assert.equal(calls.length, 3);
  assert.equal(found.get(ids[0]!), NO_DURATION);
  assert.equal(found.get(ids[119]!), 300);
});

test("a refused key pauses the API for an hour and the page reader takes over", async () => {
  let now = 0;
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    if (url.startsWith("https://www.googleapis.com/")) return new Response("denied", { status: 403 });
    return new Response('<meta itemprop="duration" content="PT30S">', { status: 200 });
  };
  const durations = new VideoDurations({ apiKey: () => "bad", fetchImpl, clock: () => now });
  const first = await durations.lookup([SHORT]);
  assert.equal(first.get(SHORT), 30);
  assert.equal(durations.mode(), "page");
  urls.length = 0;
  await durations.lookup([LONG]);
  assert.ok(urls.every((u) => u.startsWith("https://www.youtube.com/")), "no API call during the pause");
  now += 3_600_001;
  assert.equal(durations.mode(), "api");
});

test("a new key is tried at once even during a pause for the old one", async () => {
  let key = "old";
  const durations = new VideoDurations({ apiKey: () => key, fetchImpl: async () => new Response("denied", { status: 401 }) });
  await durations.lookup([SHORT]).catch(() => undefined);
  assert.equal(durations.mode(), "page");
  key = "new";
  assert.equal(durations.mode(), "api");
});

test("the page reader gives up on a missing video, and on a page with no length after three tries", async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes(GONE)) return new Response("", { status: 404 });
    return new Response("<html>consent wall</html>", { status: 200 });
  };
  const durations = new VideoDurations({ fetchImpl });
  assert.equal((await durations.lookup([GONE])).get(GONE), NO_DURATION);
  assert.equal((await durations.lookup([SHORT])).has(SHORT), false);
  assert.equal((await durations.lookup([SHORT])).has(SHORT), false);
  assert.equal((await durations.lookup([SHORT])).get(SHORT), NO_DURATION);
});

test("a network failure leaves the video unanswered so it is asked about again", async () => {
  const durations = new VideoDurations({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal((await durations.lookup([SHORT])).size, 0);
});

test("JUHANDU_DURATIONS=off builds no lookup, and the API key comes from the environment", () => {
  assert.equal(buildVideoDurations({ JUHANDU_DURATIONS: "off" }), null);
  assert.equal(buildVideoDurations({})!.mode(), "page");
  assert.equal(buildVideoDurations({ JUHANDU_YOUTUBE_API_KEY: "k" })!.mode(), "api");
});

test("a duration condition is validated and matches shorter or longer, waiting while the length is unknown", () => {
  assert.equal(validateCondition({ type: "duration", op: "under", seconds: 120 }), null);
  assert.ok(validateCondition({ type: "duration", op: "under", seconds: 0 }));
  assert.ok(validateCondition({ type: "duration", op: "over", seconds: 1.5 }));
  assert.ok(validateCondition({ type: "duration", op: "over", seconds: 8 * 86_400 }));

  const store = new Store(":memory:");
  store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "duration", op: "under", seconds: 120 } });
  const rules = store.listRules();
  const base: RuleItem = { id: 1, sourceId: 1, url: "https://www.youtube.com/watch?v=" + SHORT, folder: "", title: "t", text: "", author: "" };
  const decide = (extra: Partial<RuleItem>) => evaluateRules(rules, { ...base, ...extra });
  assert.equal(decide({ videoSeconds: 45 }).verdict, "hide");
  assert.equal(decide({ videoSeconds: 120 }).verdict, "show");
  assert.equal(decide({ videoSeconds: 600 }).verdict, "show");
  assert.equal(decide({}).verdict, "show");
  assert.equal(decide({ videoSeconds: null }).incomplete, true);
  store.close();
});

test("the processor hides a short public video, keeps a long one, and never looks up a private source", async () => {
  const store = new Store(":memory:");
  const pub = store.addSource({ kind: "feed", url: "https://yt.example/public", tier: "public" });
  const priv = store.addSource({ kind: "feed", url: "https://yt.example/private", tier: "private" });
  store.upsertItems(pub.id, [video(SHORT, "A quick clip"), video(LONG, "A long talk")]);
  store.upsertItems(priv.id, [video(GONE, "Private clip")]);
  store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "duration", op: "under", seconds: 120 } });
  const calls: { url: string; key: string | null }[] = [];
  const durations = new VideoDurations({ apiKey: () => "k", fetchImpl: apiFetch({ [SHORT]: "PT45S", [LONG]: "PT1H" }, calls), clock: () => NOW.getTime() });
  const processor = new Processor(store, null, () => NOW, durations);

  await processor.run();

  const byTitle = (title: string) => store.listItems({ view: "all" }).find((i) => i.title === title)!;
  assert.equal(byTitle("A quick clip").decision!.verdict, "hide");
  assert.equal(byTitle("A long talk").decision!.verdict, "show");
  assert.equal(byTitle("Private clip").decision!.verdict, "show");
  const asked = calls.flatMap((c) => new URL(c.url).searchParams.get("id")!.split(","));
  assert.ok(!asked.includes(GONE), "the private item's id is never sent out");
  assert.equal(store.getVideoDurations([SHORT, LONG]).get(SHORT), 45);

  const before = calls.length;
  await processor.run();
  assert.equal(calls.length, before, "a stored length is not asked for again");
  store.close();
});

test("an item waits and is judged again once the length is known", async () => {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://yt.example/public", tier: "public" });
  store.upsertItems(source.id, [video(SHORT, "A quick clip")]);
  store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "duration", op: "under", seconds: 120 } });
  let online = false;
  const fetchImpl: FetchLike = async (url, init) => {
    if (!online) throw new Error("offline");
    return apiFetch({ [SHORT]: "PT30S" })(url, init);
  };
  const processor = new Processor(store, null, () => NOW, new VideoDurations({ apiKey: () => "k", fetchImpl }));

  await processor.run();
  assert.equal(store.listItems({ view: "filtered" }).length, 0);
  assert.equal(store.itemsNeedingDecision(10).length, 1, "still waiting");

  online = true;
  await processor.run();
  assert.equal(store.listItems({ view: "filtered" }).length, 1);
  assert.equal(store.itemsNeedingDecision(10).length, 0);
  store.close();
});

test("the rules API accepts a duration condition and refuses a bad one", async () => {
  const store = new Store(":memory:");
  const server = createApp({ store, ingestor: new Ingestor(store), processor: new Processor(store, null, () => NOW), webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (condition: unknown) => {
    const response = await fetch(base + "/api/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "block", scope: { type: "all" }, condition }) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  try {
    const ok = await post({ type: "duration", op: "under", seconds: 120 });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body["rule"].condition, { type: "duration", op: "under", seconds: 120 });
    assert.equal((await post({ type: "duration", op: "under", seconds: 0 })).status, 422);
    assert.equal((await post({ type: "duration", op: "over" })).status, 422);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
