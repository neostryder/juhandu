import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Embedder } from "../src/models/embedder.ts";
import type { ModelProvider } from "../src/models/provider.ts";
import { Processor } from "../src/pipeline/process.ts";
import { Store } from "../src/store/store.ts";
import { tasteTopics } from "../src/taste/taste.ts";
import { normalize } from "../src/taste/vectors.ts";

const TAG = "taste-test";
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86400_000);

function world(t: TestContext, count = 8) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed" });
  store.upsertItems(source.id, Array.from({ length: count }, (_, i) => ({
    guid: String(i), url: `https://x.example/${i}`, title: `Item ${i}`, author: "",
    publishedAt: new Date(NOW.getTime() - (count - i) * 60_000).toISOString(),
    summaryText: "", contentHtml: "", image: "", titleHash: String(i), extra: {},
  })));
  const ids = (store.db.prepare("SELECT id FROM items ORDER BY id").all() as { id: number }[]).map((row) => row.id);
  const vote = (index: number, vector: number[] | null, sign = 1, reason = "", at = NOW, model = TAG) => {
    const id = ids[index]!;
    store.setVote(id, sign, reason, at);
    if (vector) store.saveEmbedding(id, model, normalize(vector));
    return id;
  };
  return { store, ids, vote };
}

async function serve(t: TestContext, store: Store, enabled = true) {
  const provider: ModelProvider = {
    name: "fake", capabilities: { embed: true, chat: false, decide: false, transcribe: false },
    embeddingModel: async () => TAG,
    embed: async (request) => ({ model: TAG, vectors: request.texts.map(() => normalize([1, 0])) }),
    chat: async () => { throw new Error("unused"); },
    status: async () => ({ name: "fake", ok: true, detail: "", serves: [] }),
  };
  const processor = new Processor(store, enabled ? new Embedder({ provider }) : null);
  const app = createApp({ store, ingestor: new Ingestor(store), processor, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => app.close(() => resolve())));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown) => fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { processor, call };
}

function snapshot(store: Store, table: string) {
  return store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map((row) => ({ ...row }));
}

test("topics join connected votes across signs and omit items without current embeddings or singleton reasons", async (t) => {
  const { store, ids, vote } = world(t, 9);
  vote(0, [1, 0], 1, "", ago(3));
  vote(1, [0.819, 0.574], -1, "", ago(2));
  vote(2, [0.342, 0.940], 1, "", ago(1));
  vote(3, [-1, 0], -1, "A reason");
  vote(4, [0, -1]);
  vote(5, null, 1, "No vector");
  vote(6, [1, 0], 1, "Old model", NOW, "old");
  vote(7, [1, 0], 1, "", ago(4));
  store.saveEmbedding(ids[8]!, TAG, normalize([1, 0]));
  const { call } = await serve(t, store);
  const response = await call("/api/taste/topics");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.undo, null);
  assert.equal(body.topics.length, 2);
  assert.deepEqual(body.topics[0], { itemIds: [ids[3]], liked: 0, disliked: 1, titles: ["Item 3"], lastVotedAt: NOW.toISOString() });
  assert.deepEqual([...body.topics[1].itemIds].sort((a, b) => a - b), [ids[0], ids[1], ids[2], ids[7]]);
  assert.deepEqual(body.topics[1].titles, ["Item 7", "Item 2", "Item 1"]);
  assert.equal(body.topics[1].liked, 3);
  assert.equal(body.topics[1].disliked, 1);
  assert.equal(body.topics[1].lastVotedAt, ago(1).toISOString());
});

test("topics keep the 50 largest groups and order them by newest activity", (t) => {
  const { store, ids, vote } = world(t, 105);
  for (let group = 0; group < 52; group++) {
    const vector = Array.from({ length: 52 }, (_, i) => Number(i === group));
    vote(group * 2, vector, 1, "", ago(group + 1));
    vote(group * 2 + 1, vector, -1, "", ago(group + 1));
  }
  vote(104, Array.from({ length: 52 }, (_, i) => Number(i === 51)), 1, "", ago(52));
  const topics = tasteTopics(store, TAG);
  assert.equal(topics.length, 50);
  assert.equal(topics[0]!.lastVotedAt, ago(1).toISOString());
  assert.equal(topics.at(-1)!.itemIds.length, 3);
  assert.ok(topics.at(-1)!.itemIds.includes(ids[104]!));
  assert.ok(!topics.some((topic) => topic.itemIds.includes(ids[100]!)));
});

test("topics include voted items beyond the proposer's default vote limit and a reset accepts 500 ids", async (t) => {
  const { store, ids, vote } = world(t, 602);
  for (let i = 0; i < 602; i++) vote(i, [1, 0]);
  assert.equal(tasteTopics(store, TAG)[0]!.itemIds.length, 602);
  const { call } = await serve(t, store);
  const response = await call("/api/taste/reset", { itemIds: ids.slice(0, 500) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cleared, 500);
  assert.equal(tasteTopics(store, TAG)[0]!.itemIds.length, 102);
});

test("reset archives exact votes, ignores duplicates and unvoted or unembedded ids, and leaves other data intact", async (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0], 1, "First", ago(2));
  vote(1, [1, 0], -1, "Second", ago(1));
  vote(2, [0, 1]);
  vote(3, null, -1, "No vector");
  vote(4, [1, 0], -1, "Old vector", NOW, "old");
  store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "keyword", terms: ["absent"], mode: "any", fields: ["title"] } });
  const before = Object.fromEntries(["rules", "items", "embeddings", "decisions"].map((table) => [table, snapshot(store, table)]));
  const votes = snapshot(store, "votes");
  const { call } = await serve(t, store);
  const response = await call("/api/taste/reset", { itemIds: [ids[0], ids[1], ids[0], ids[3], ids[4], ids[5], 99999] });
  assert.equal(response.status, 200);
  const { resetId, cleared } = await response.json();
  assert.equal(cleared, 2);
  assert.deepEqual(snapshot(store, "vote_archive"), votes.slice(0, 2).map((v) => ({ reset_id: resetId, item_id: v["item_id"], vote: v["vote"], reason: v["reason"], voted_at: v["created_at"] })));
  assert.deepEqual(snapshot(store, "votes"), votes.slice(2));
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(snapshot(store, table), rows);
  const { undo } = await (await call("/api/taste/topics")).json();
  assert.equal(undo.resetId, resetId);
  assert.equal(undo.cleared, 2);
  assert.equal(typeof undo.at, "string");
});

test("reset rolls back the archive, removals and metadata if a deletion fails", (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0]);
  vote(1, [1, 0], -1);
  const before = snapshot(store, "votes");
  const version = store.getMeta("votes_version");
  store.db.exec(`CREATE TRIGGER stop_reset BEFORE DELETE ON votes WHEN old.item_id = ${ids[1]} BEGIN SELECT RAISE(ABORT, 'stop reset'); END`);
  assert.throws(() => store.resetVotes([ids[0]!, ids[1]!], TAG), /stop reset/);
  assert.deepEqual(snapshot(store, "votes"), before);
  assert.deepEqual(snapshot(store, "vote_archive"), []);
  assert.deepEqual(snapshot(store, "vote_resets"), []);
  assert.equal(store.getMeta("votes_version"), version);
});

test("reset rejects invalid id lists and lists without eligible votes with 400", async (t) => {
  const { store, ids } = world(t);
  const { call } = await serve(t, store);
  for (const body of [{}, { itemIds: [] }, { itemIds: [0] }, { itemIds: [-1] }, { itemIds: [1.5] }, { itemIds: ["1"] }, { itemIds: [null] }, { itemIds: [Number.MAX_SAFE_INTEGER + 1] }, { itemIds: Array(501).fill(1) }, { itemIds: [ids[0]] }]) {
    const response = await call("/api/taste/reset", body);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /itemIds|nothing was reset/);
  }
  assert.deepEqual(snapshot(store, "vote_resets"), []);
});

test("embeddings being off yields no topics and never clears a vote", async (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0], 1, "Reason");
  const { call } = await serve(t, store, false);
  assert.deepEqual((await (await call("/api/taste/topics")).json()).topics, []);
  assert.equal((await call("/api/taste/reset", { itemIds: [ids[0]] })).status, 400);
  assert.equal(store.votedItems().length, 1);
});

test("undo restores original votes and reasons while preserving newer votes and other rules", async (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0], 1, "Original", ago(2));
  vote(1, [1, 0], -1, "Old dislike", ago(1));
  vote(2, [0, 1], -1, "Other topic");
  store.addRule({ kind: "pin", scope: { type: "all" }, condition: { type: "keyword", terms: ["Item"], mode: "any", fields: ["title"] } });
  const rules = snapshot(store, "rules");
  const original = snapshot(store, "votes");
  const { call } = await serve(t, store);
  const { resetId } = await (await call("/api/taste/reset", { itemIds: ids.slice(0, 2) })).json();
  assert.equal((await call(`/api/items/${ids[1]}/vote`, { vote: 1, reason: "New like" })).status, 200);
  const newer = snapshot(store, "votes")[0];
  const response = await call(`/api/taste/reset/${resetId}/undo`, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { restored: 1, skipped: 1 });
  assert.deepEqual(snapshot(store, "votes"), [original[0], newer, original[2]]);
  assert.deepEqual(snapshot(store, "rules"), rules);
  assert.deepEqual((await (await call("/api/taste/topics")).json()).undo, null);
  assert.equal((await call(`/api/taste/reset/${resetId}/undo`, {})).status, 404);
});

test("expired and unknown resets answer 404 and disappear from undo", async (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0]);
  const expired = store.resetVotes([ids[0]!], TAG, ago(8))!;
  const { call } = await serve(t, store);
  for (const id of [expired.resetId, 99999]) {
    const response = await call(`/api/taste/reset/${id}/undo`, {});
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /cannot be undone/);
  }
  assert.equal((await (await call("/api/taste/topics")).json()).undo, null);
  assert.deepEqual(snapshot(store, "votes"), []);
});

test("the newest available reset is offered and undo falls back to the previous reset", (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0]);
  vote(1, [0, 1]);
  const first = store.resetVotes([ids[0]!], TAG, ago(2))!;
  const second = store.resetVotes([ids[1]!], TAG, ago(1))!;
  assert.equal(store.latestVoteReset(NOW)!.resetId, second.resetId);
  store.undoVoteReset(second.resetId, NOW);
  assert.equal(store.latestVoteReset(NOW)!.resetId, first.resetId);
  assert.deepEqual(store.undoVoteReset(first.resetId, new Date(ago(2).getTime() + 7 * 86400_000)), { restored: 1, skipped: 0 });
});

test("undo can replace an older vote restored from an earlier reset", (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0], -1, "First", ago(4));
  const first = store.resetVotes([ids[0]!], TAG, ago(3))!;
  vote(0, [1, 0], 1, "Second", ago(2));
  const second = store.resetVotes([ids[0]!], TAG, ago(1))!;
  assert.deepEqual(store.undoVoteReset(first.resetId, NOW), { restored: 1, skipped: 0 });
  assert.deepEqual(store.undoVoteReset(second.resetId, NOW), { restored: 1, skipped: 0 });
  assert.equal(store.votedItems()[0]!.reason, "Second");
});

test("a new reset deletes archives older than 30 days and keeps recent archives", (t) => {
  const { store, ids, vote } = world(t);
  for (let i = 0; i < 3; i++) vote(i, [1, 0]);
  const old = store.resetVotes([ids[0]!], TAG, ago(31))!;
  const recent = store.resetVotes([ids[1]!], TAG, ago(29))!;
  store.resetVotes([ids[2]!], TAG, NOW);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM vote_archive WHERE reset_id = ?").get(old.resetId)!["n"], 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM vote_archive WHERE reset_id = ?").get(recent.resetId)!["n"], 1);
});

test("reset and undo refresh an existing nearby item's taste score without changing its decision", async (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0]);
  vote(1, [0, 1]);
  store.saveEmbedding(ids[2]!, TAG, normalize([1, 0]));
  const { processor, call } = await serve(t, store);
  await processor.decidePending();
  const decision = () => store.listItems({ view: "all", itemId: ids[2] })[0]!.decision!;
  const before = decision();
  assert.ok(before.taste! > 0.5);
  const { resetId } = await (await call("/api/taste/reset", { itemIds: [ids[0]] })).json();
  assert.equal(decision().taste, 0);
  assert.deepEqual({ ...decision(), taste: null }, { ...before, taste: null });
  await call(`/api/taste/reset/${resetId}/undo`, {});
  assert.equal(decision().taste, before.taste);
  await call(`/api/items/${ids[0]}/vote`, { vote: 0 });
  assert.equal(decision().taste, 0);
  await call(`/api/items/${ids[1]}/vote`, { vote: 0 });
  assert.equal(decision().taste, null);
});

test("the background pass refreshes scores after vote changes that leave the vote counts unchanged", async (t) => {
  const { store, ids, vote } = world(t);
  vote(0, [1, 0]);
  vote(1, [0, 1]);
  store.saveEmbedding(ids[2]!, TAG, normalize([1, 0]));
  store.saveEmbedding(ids[3]!, TAG, normalize([0, 1]));
  const { processor } = await serve(t, store);
  await processor.decidePending();
  const score = () => store.listItems({ view: "all", itemId: ids[2] })[0]!.decision!.taste;
  assert.ok(score()! > 0.5);
  store.resetVotes([ids[0]!], TAG);
  store.setVote(ids[3]!, 1);
  assert.equal(await processor.decidePending(), 0);
  assert.equal(score(), 0);
});

test("the migration opens the prior schema and preserves existing votes and rules", (t) => {
  const folder = mkdtempSync(join(process.cwd(), ".taste-reset-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, "store.sqlite");
  const store = new Store(path);
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed" });
  store.upsertItems(source.id, [{ guid: "old", url: "https://x.example/old", title: "Old item", author: "", publishedAt: null, summaryText: "", contentHtml: "", image: "", titleHash: "old", extra: {} }]);
  store.setVote(store.listItems({ view: "all" })[0]!.id, -1, "Old reason", ago(1));
  const votes = snapshot(store, "votes");
  store.addRule({ kind: "pin", scope: { type: "all" }, condition: { type: "keyword", terms: ["Item"], mode: "any", fields: ["title"] } });
  const rules = snapshot(store, "rules");
  const version = Number(store.db.prepare("PRAGMA user_version").get()!["user_version"]);
  store.db.exec(`DROP TABLE vote_archive; DROP TABLE vote_resets; PRAGMA user_version = ${version - 1}`);
  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.db.prepare("PRAGMA user_version").get()!["user_version"], version);
    assert.deepEqual(snapshot(reopened, "vote_archive"), []);
    assert.deepEqual(snapshot(reopened, "vote_resets"), []);
    assert.deepEqual(snapshot(reopened, "rules"), rules);
    assert.deepEqual(snapshot(reopened, "votes"), votes);
    assert.equal(reopened.getSource(source.id)!.url, source.url);
  } finally {
    reopened.close();
  }
});
