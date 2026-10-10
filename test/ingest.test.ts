import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Ingestor, nextDelayMs } from "../src/ingest/ingest.ts";
import { createApp } from "../src/api/server.ts";
import { Store } from "../src/store/store.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fake Feed</title><link>https://fake.example/</link>
<item><title>Alpha story</title><link>/a</link><guid>a</guid><pubDate>Tue, 06 Oct 2026 08:00:00 GMT</pubDate><description>&lt;p&gt;Alpha &lt;b&gt;body&lt;/b&gt;&lt;/p&gt;</description></item>
<item><title>Beta story</title><link>/b</link><guid>b</guid><pubDate>Tue, 06 Oct 2026 09:00:00 GMT</pubDate></item>
</channel></rss>`;

function fakeFetch(handler: (url: string, headers: Record<string, string>) => Response): { fetch: FetchLike; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers });
      return handler(url, headers);
    },
  };
}

test("polls a feed, stores items, then sends conditional headers and handles 304", async () => {
  const store = new Store(":memory:");
  const fake = fakeFetch((_url, headers) => (headers["if-none-match"] === '"v1"' ? new Response(null, { status: 304 }) : new Response(FEED, { status: 200, headers: { etag: '"v1"', "content-type": "application/rss+xml" } })));
  let now = new Date("2026-10-06T10:00:00Z");
  const ingestor = new Ingestor(store, fake.fetch, () => now, () => 0.5);
  const source = store.addSource({ kind: "feed", url: "https://fake.example/feed" }, now);

  const first = await ingestor.pollSource(source);
  assert.equal(first.status, "updated");
  assert.equal(first.inserted, 2);
  const items = store.listItems();
  assert.equal(items[0]!.title, "Beta story");
  assert.equal(items[1]!.url, "https://fake.example/a");
  assert.equal(items[1]!.summaryText, "Alpha body");
  assert.equal(store.getSource(source.id)!.title, "Fake Feed");

  now = new Date("2026-10-06T11:00:00Z");
  const second = await ingestor.pollSource(store.getSource(source.id)!);
  assert.equal(second.status, "not-modified");
  assert.equal(fake.calls[1]!.headers["if-none-match"], '"v1"');
  assert.equal(store.counts().items, 2);
  store.close();
});

test("a failing source backs off and recovers cleanly", async () => {
  const store = new Store(":memory:");
  let fail = true;
  const fake = fakeFetch(() => (fail ? new Response("nope", { status: 503 }) : new Response(FEED, { status: 200 })));
  const now = new Date("2026-10-06T10:00:00Z");
  const ingestor = new Ingestor(store, fake.fetch, () => now, () => 0.5);
  const source = store.addSource({ kind: "feed", url: "https://fake.example/feed", pollMinutes: 30 }, now);

  const bad = await ingestor.pollSource(source);
  assert.equal(bad.status, "error");
  const after = store.getSource(source.id)!;
  assert.equal(after.errorCount, 1);
  assert.equal(after.lastError, "HTTP 503");
  assert.equal(new Date(after.nextFetchAt).getTime() - now.getTime(), 60 * 60_000);

  fail = false;
  const good = await ingestor.pollSource(after);
  assert.equal(good.status, "updated");
  assert.equal(store.getSource(source.id)!.errorCount, 0);
  store.close();
});

test("backoff doubles per failure, caps at a day, and honors Retry-After", () => {
  const mid = () => 0.5;
  assert.equal(nextDelayMs(30, 0, null, mid), 30 * 60_000);
  assert.equal(nextDelayMs(30, 2, null, mid), 120 * 60_000);
  assert.equal(nextDelayMs(30, 20, null, mid), 24 * 60 * 60_000);
  assert.equal(nextDelayMs(30, 0, 7200, mid), 7200 * 1000);
});

test("pollDue only polls sources whose time has come", async () => {
  const store = new Store(":memory:");
  const fake = fakeFetch(() => new Response(FEED, { status: 200 }));
  const now = new Date("2026-10-06T10:00:00Z");
  const ingestor = new Ingestor(store, fake.fetch, () => now, () => 0.5);
  store.addSource({ kind: "feed", url: "https://one.example/feed" }, now);
  const later = store.addSource({ kind: "feed", url: "https://two.example/feed" }, new Date("2026-10-06T12:00:00Z"));
  const results = await ingestor.pollDue();
  assert.equal(results.length, 1);
  assert.notEqual(results[0]!.sourceId, later.id);
  store.close();
});

const JSON_TYPE = { "content-type": "application/json" };

test("HTTP API: add a source by URL, list items, mark read, reject bad input", async () => {
  const store = new Store(":memory:");
  const fake = fakeFetch(() => new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml" } }));
  const ingestor = new Ingestor(store, fake.fetch);
  const server = createApp({ store, ingestor, fetchImpl: fake.fetch, webRoot: new URL("../web", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const added = await fetch(`${base}/api/sources`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ url: "https://fake.example/feed" }) });
    assert.equal(added.status, 201);
    const again = await fetch(`${base}/api/sources`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ url: "https://fake.example/feed" }) });
    assert.equal(((await again.json()) as { alreadySubscribed: boolean }).alreadySubscribed, true);

    const list = (await (await fetch(`${base}/api/items?limit=5`)).json()) as { items: { id: number; read: boolean }[] };
    assert.equal(list.items.length, 2);
    const id = list.items[0]!.id;
    assert.equal((await fetch(`${base}/api/items/${id}/read`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ read: true }) })).status, 200);
    const unread = (await (await fetch(`${base}/api/items?unread=1`)).json()) as { items: unknown[] };
    assert.equal(unread.items.length, 1);

    assert.equal((await fetch(`${base}/api/sources`, { method: "POST", headers: JSON_TYPE, body: JSON.stringify({ url: "file:///etc/passwd" }) })).status, 422);
    assert.equal((await fetch(`${base}/api/sources`, { method: "POST", headers: JSON_TYPE, body: "not json" })).status, 400);
    assert.equal((await fetch(`${base}/api/items?limit=abc`)).status, 400);
    assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
    assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404);
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  } finally {
    server.close();
    store.close();
  }
});
