import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";
import { Store } from "../src/store/store.ts";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Plain Feed</title><link>https://plain.example/</link>
<item><title>One story</title><link>https://plain.example/a</link><guid>a</guid></item></channel></rss>`;

async function rig() {
  const store = new Store(":memory:");
  const fetchImpl: FetchLike = async () => new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml" } });
  const server = createApp({ store, ingestor: new Ingestor(store, fetchImpl), fetchImpl, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    call: (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

test("a feed added with a tier and folder keeps them, and both can be changed afterwards", async () => {
  const r = await rig();
  try {
    const added = await r.call("POST", "/api/sources", { url: "https://plain.example/feed", tier: "private", folder: "Family" });
    assert.equal(added.status, 201);
    const { source } = (await added.json()) as { source: { id: number; tier: string; folder: string; pollMinutes: number } };
    assert.equal(source.tier, "private");
    assert.equal(source.folder, "Family");
    const itemId = r.store.listSources().length ? 1 : 0;
    assert.equal(r.store.itemTiers([itemId]).get(itemId), "private");

    const changed = await r.call("PATCH", `/api/sources/${source.id}`, { tier: "public", folder: "  News  ", pollMinutes: 120 });
    assert.equal(changed.status, 200);
    const after = ((await changed.json()) as { source: { tier: string; folder: string; pollMinutes: number } }).source;
    assert.deepEqual([after.tier, after.folder, after.pollMinutes], ["public", "News", 120]);
    assert.equal(r.store.itemTiers([itemId]).get(itemId), "public", "the feed's items follow its tier at once");

    const partial = await r.call("PATCH", `/api/sources/${source.id}`, { tier: "private" });
    const kept = ((await partial.json()) as { source: { tier: string; folder: string; pollMinutes: number } }).source;
    assert.deepEqual([kept.tier, kept.folder, kept.pollMinutes], ["private", "News", 120], "fields left out stay as they were");
  } finally {
    await r.close();
  }
});

test("a bad change is refused and nothing changes", async () => {
  const r = await rig();
  try {
    const added = await r.call("POST", "/api/sources", { url: "https://plain.example/feed" });
    const { source } = (await added.json()) as { source: { id: number } };
    for (const body of [{}, { tier: "secret" }, { folder: 5 }, { pollMinutes: 1 }, { pollMinutes: 99999 }, { pollMinutes: 10.5 }, { pollMinutes: "30" }]) {
      const res = await r.call("PATCH", `/api/sources/${source.id}`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await r.call("PATCH", "/api/sources/9999", { tier: "private" })).status, 404);
    const now = r.store.getSource(source.id);
    assert.deepEqual([now?.tier, now?.folder, now?.pollMinutes], ["public", "", 30]);
  } finally {
    await r.close();
  }
});
