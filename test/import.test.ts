import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { importOpml, parseOpml, previewOpml } from "../src/import/opml.ts";
import { Store } from "../src/store/store.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline text="AI" title="AI">
      <outline type="rss" text="Alpha Blog" title="Alpha Blog" xmlUrl="https://alpha.example/feed.xml" htmlUrl="https://alpha.example/"/>
      <outline type="rss" text="Beta &amp; Co" title="Beta &amp; Co" xmlUrl="https://beta.example/rss"/>
    </outline>
    <outline text="Music">
      <outline text="Indie">
        <outline type="rss" text="Gamma" xmlUrl="https://gamma.example/atom"/>
      </outline>
    </outline>
    <outline text="YouTube">
      <outline type="rss" text="A Channel" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"/>
    </outline>
    <outline type="rss" text="Loose" xmlUrl="https://loose.example/feed" category="Misc"/>
    <outline type="rss" text="Again" xmlUrl="https://alpha.example/feed.xml"/>
    <outline type="rss" text="Broken" xmlUrl="ftp://nope.example/feed"/>
  </body>
</opml>`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "juhandu-import-"));
}

test("parseOpml reads folders, nested folders, the category fallback and the YouTube kind, and sets aside repeats and bad addresses", () => {
  const parsed = parseOpml(OPML);
  const byTitle = new Map(parsed.feeds.map((f) => [f.title, f]));
  assert.equal(parsed.feeds.length, 5);
  assert.equal(byTitle.get("Alpha Blog")?.folder, "AI");
  assert.equal(byTitle.get("Alpha Blog")?.siteUrl, "https://alpha.example/");
  assert.equal(byTitle.get("Beta & Co")?.folder, "AI", "entities are decoded");
  assert.equal(byTitle.get("Gamma")?.folder, "Music / Indie", "nested folders are joined");
  assert.equal(byTitle.get("A Channel")?.kind, "youtube");
  assert.equal(byTitle.get("Alpha Blog")?.kind, "feed");
  assert.equal(byTitle.get("Loose")?.folder, "Misc", "a feed outside any folder falls back to its category");
  assert.deepEqual(parsed.invalid.map((i) => i.reason).sort(), ["Listed twice in the file", "Not an http or https address"]);
});

test("parseOpml refuses text with no body and tolerates an outline with no title", () => {
  assert.throws(() => parseOpml("<opml><head/></opml>"), /no body/);
  const parsed = parseOpml(`<opml><body><outline xmlUrl="https://x.example/feed"/></body></opml>`);
  assert.equal(parsed.feeds.length, 1);
  assert.equal(parsed.feeds[0]?.title, "");
  assert.equal(parsed.feeds[0]?.folder, "");
});

test("previewOpml marks what is already subscribed, and importOpml adds the rest without fetching", () => {
  const dir = tempDir();
  const store = new Store(join(dir, "j.sqlite"));
  try {
    store.addSource({ kind: "feed", url: "https://beta.example/rss", title: "Beta", siteUrl: "", folder: "Old", tier: "public" });
    const preview = previewOpml(store, OPML);
    assert.deepEqual(preview.counts, { total: 5, new: 4, subscribed: 1, invalid: 2, folders: 4 });
    assert.equal(preview.entries.find((e) => e.title === "Beta & Co")?.status, "subscribed");

    const result = importOpml(store, OPML, { tier: "private", skip: ["https://gamma.example/atom"] });
    assert.deepEqual(result, { added: 3, alreadySubscribed: 1, skipped: 1, invalid: 2 });
    const sources = store.listSources();
    assert.equal(sources.length, 4);
    const alpha = sources.find((s) => s.url === "https://alpha.example/feed.xml");
    assert.equal(alpha?.folder, "AI");
    assert.equal(alpha?.tier, "private");
    assert.equal(sources.find((s) => s.url === "https://beta.example/rss")?.folder, "Old", "an existing subscription is left as it was");
    assert.equal(sources.find((s) => s.title === "A Channel")?.kind, "youtube");

    const again = importOpml(store, OPML);
    assert.equal(again.added, 1, "only the one that was skipped is new on a second run");
    assert.equal(importOpml(store, OPML).added, 0, "a third run adds nothing");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function rig() {
  const folder = tempDir();
  const store = new Store(join(folder, "j.sqlite"));
  const fetchImpl: FetchLike = async () => {
    throw new Error("the import must not fetch anything");
  };
  const server = createApp({ store, ingestor: new Ingestor(store, fetchImpl), fetchImpl, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    call: (method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

test("the API previews and imports an OPML file and rejects empty or unreadable text", async () => {
  const r = await rig();
  try {
    assert.equal((await r.call("POST", "/api/import/opml/preview", { opml: "  " })).status, 400);
    assert.equal((await r.call("POST", "/api/import/opml", {})).status, 400);
    assert.equal((await r.call("POST", "/api/import/opml/preview", { opml: "<opml><head/></opml>" })).status, 422);

    const preview = await r.call("POST", "/api/import/opml/preview", { opml: OPML });
    assert.equal(preview.status, 200);
    const shown = (await preview.json()) as { counts: { total: number; new: number } };
    assert.equal(shown.counts.total, 5);
    assert.equal(r.store.listSources().length, 0, "a preview adds nothing");

    const done = await r.call("POST", "/api/import/opml", { opml: OPML, tier: "private", skip: ["https://loose.example/feed"] });
    assert.equal(done.status, 201);
    assert.deepEqual(await done.json(), { added: 4, alreadySubscribed: 0, skipped: 1, invalid: 2 });
    const sources = r.store.listSources();
    assert.equal(sources.length, 4);
    assert.ok(sources.every((s) => s.tier === "private"));
    assert.ok(sources.every((s) => !s.lastFetchedAt), "the feeds wait for the poller");
  } finally {
    await r.close();
  }
});

test("POST /api/items/read-all marks every unread item read and says how many", async () => {
  const r = await rig();
  try {
    const source = r.store.addSource({ kind: "feed", url: "https://one.example/feed", title: "One", siteUrl: "", folder: "", tier: "public" });
    const item = (n: number) => ({ guid: `g${n}`, url: `https://one.example/${n}`, title: `Post ${n}`, author: "", publishedAt: null, summaryText: "", contentHtml: "", image: "", titleHash: `h${n}`, extra: {} });
    r.store.upsertItems(source.id, [item(1), item(2), item(3)]);
    const before = (await (await r.call("GET", "/api/health")).json()) as { unread: number };
    assert.equal(before.unread, 3);
    const marked = (await (await r.call("POST", "/api/items/read-all", {})).json()) as { marked: number };
    assert.equal(marked.marked, 3);
    const after = (await (await r.call("GET", "/api/health")).json()) as { unread: number };
    assert.equal(after.unread, 0);
    assert.equal(((await (await r.call("POST", "/api/items/read-all", {})).json()) as { marked: number }).marked, 0);
  } finally {
    await r.close();
  }
});
