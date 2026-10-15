import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { EgressGate } from "../src/models/egress.ts";
import { buildJudge } from "../src/judges/setup.ts";
import { SystemOneJudge } from "../src/judges/systemone.ts";
import { MIN_HUMAN_TEST, MIN_HUMAN_TRAIN, buildTrainingExport, parseLanes, splitOf, toJsonl } from "../src/training/export.ts";
import { laneModel, wantsQuestion } from "../src/training/lanes.ts";
import { Store } from "../src/store/store.ts";
import type { JudgmentEntry, NewItem } from "../src/store/store.ts";

const NOW = new Date("2026-10-08T12:00:00Z");

function item(guid: string, title: string): NewItem {
  return { guid, url: `https://x.example/${guid}`, title, author: "", publishedAt: "2026-10-08T10:00:00Z", summaryText: `About ${title}.`, contentHtml: "", image: "", titleHash: guid, extra: {} };
}

function entry(partial: Partial<JudgmentEntry> & { provider: string; probability: number }): JudgmentEntry {
  const { provider, probability, ...rest } = partial;
  return {
    kind: "yes_no",
    question: "Do these two feed items report the same news story or event?",
    input: { item_a_title: "A", item_b_title: "B" },
    output: { answer: probability >= 0.5, probability, calibrated: true, model: "m" },
    model: "m",
    provider,
    priority: "background",
    tier: "public",
    lane: "same_story",
    ...rest,
  };
}

test("a judgment is stored with its lane, and an old row has none", () => {
  const store = new Store(":memory:");
  store.logJudgment(entry({ provider: "jev", probability: 0.9 }), NOW);
  store.logJudgment({ ...entry({ provider: "jev", probability: 0.9 }), lane: undefined }, NOW);
  const [newest, oldest] = store.recentJudgments(5);
  assert.equal(oldest!.lane, "same_story");
  assert.equal(newest!.lane, "");
  assert.deepEqual(store.laneJudgments(["same_story"]).length, 1);
  assert.deepEqual(store.laneJudgments([]), []);
  store.close();
});

test("the install id is made once and kept", () => {
  const store = new Store(":memory:");
  const id = store.installId();
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(store.installId(), id);
  store.close();
});

test("The teacher's answer is the label and the local shadow answer rides beside it", () => {
  const store = new Store(":memory:");
  store.logJudgment(entry({ provider: "jev", probability: 0.92 }), NOW);
  store.logJudgment(entry({ provider: "typed", probability: 0.5, role: "shadow" }), NOW);
  store.logJudgment(entry({ provider: "jev", probability: 0.1, input: { item_a_title: "C", item_b_title: "D" } }), NOW);
  store.logJudgment(entry({ provider: "typed", probability: 0.5, role: "shadow", input: { item_a_title: "only", item_b_title: "typed" } }), NOW);
  const built = buildTrainingExport(store, { lanes: ["same_story"] });
  assert.equal(built.rows.length, 2);
  const row = built.rows.find((r) => r.teacher!.answers["answer"]!.noul === 0.92)!;
  assert.equal(row.lane, "same_story");
  assert.ok(Math.abs(row.teacher!.answers["inverse"]!.noul - 0.08) < 1e-9);
  assert.equal(row.local!.answers["answer"]!.noul, 0.5);
  assert.deepEqual(Object.keys(row.questions), ["answer", "inverse"]);
  assert.deepEqual((row.state as { subject: unknown }).subject, { item_a_title: "A", item_b_title: "B" });
  const summary = built.summaries[0]!;
  assert.equal(summary.teacher, 2);
  assert.equal(summary.unlabeled, 1);
  assert.equal(summary.shippable, false, "Jev-taught rows alone never make a shippable adapter");
  store.close();
});

test("the same question asked again exports once, with the newest teacher answer", () => {
  const store = new Store(":memory:");
  store.logJudgment(entry({ provider: "jev", probability: 0.2 }), NOW);
  store.logJudgment(entry({ provider: "jev", probability: 0.8 }), NOW);
  const rows = buildTrainingExport(store, { lanes: ["same_story"] }).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.teacher!.answers["answer"]!.noul, 0.8);
  store.close();
});

test("the user's votes become human rows, and private feeds stay out unless asked for", () => {
  const store = new Store(":memory:");
  const pub = store.addSource({ kind: "feed", url: "https://pub.example/feed", folder: "News", tier: "public" });
  const priv = store.addSource({ kind: "feed", url: "https://priv.example/feed", folder: "Work", tier: "private" });
  store.upsertItems(pub.id, [item("a", "A good one"), item("b", "A bad one")], NOW);
  store.upsertItems(priv.id, [item("c", "Private thing")], NOW);
  const ids = Object.fromEntries(store.listItems({ limit: 10, view: "all", wide: true }).map((i) => [i.guid, i.id]));
  store.setVote(ids["a"]!, 1, "love it", NOW);
  store.setVote(ids["b"]!, -1, "", NOW);
  store.setVote(ids["c"]!, 1, "", NOW);
  const built = buildTrainingExport(store, { lanes: ["wants"] });
  assert.equal(built.rows.length, 2);
  const liked = built.rows.find((r) => r.human!.answer)!;
  assert.deepEqual(liked.human, { answer: true, inverse: false });
  assert.equal(liked.note, "love it");
  assert.equal((liked.state as { subject: Record<string, string> }).subject["title"], "A good one");
  assert.ok(!JSON.stringify(built.rows).includes("Private thing"));
  assert.equal(buildTrainingExport(store, { lanes: ["wants"], includePrivate: true }).rows.length, 3);
  const summary = built.summaries[0]!;
  assert.equal(summary.human, 2);
  assert.equal(summary.shippable, true);
  assert.equal(summary.ready, false);
  store.close();
});

test("a lane is ready once there are enough human rows on both sides of the split", () => {
  const store = new Store(":memory:");
  const pub = store.addSource({ kind: "feed", url: "https://pub.example/feed", folder: "News", tier: "public" });
  const items: NewItem[] = [];
  for (let n = 0; n < 400; n++) items.push(item(`g${n}`, `Headline number ${n}`));
  store.upsertItems(pub.id, items, NOW);
  for (const i of store.listItems({ limit: 500, view: "all", wide: true })) store.setVote(i.id, i.id % 2 ? 1 : -1, "", NOW);
  const summary = buildTrainingExport(store, { lanes: ["wants"] }).summaries[0]!;
  assert.equal(summary.human, 400);
  assert.ok(summary.humanTrain >= MIN_HUMAN_TRAIN && summary.humanTest >= MIN_HUMAN_TEST);
  assert.equal(summary.ready, true);
  store.close();
});

test("the split is sha1 of the id, and a fifth is test", () => {
  assert.equal(splitOf("jhd-aaaaaaaaaaaa-wants-1"), splitOf("jhd-aaaaaaaaaaaa-wants-1"));
  const sides = Array.from({ length: 500 }, (_, n) => splitOf(`row-${n}`));
  const test = sides.filter((s) => s === "test").length;
  assert.ok(test > 60 && test < 140, `about a fifth are test, got ${test}`);
});

test("lane names are checked and the JSONL has one row per line", () => {
  assert.deepEqual(parseLanes("wants,pipe_ask"), ["wants", "pipe_ask"]);
  assert.deepEqual(parseLanes(""), []);
  assert.throws(() => parseLanes("wants,nope"), /Unknown lane "nope"/);
  assert.equal(toJsonl([]), "");
  const text = toJsonl([{ id: "a", lane: "wants", ts: "t", state: {}, questions: {} }, { id: "b", lane: "wants", ts: "t", state: {}, questions: {} }]);
  assert.equal(text.trim().split("\n").length, 2);
});

test("the wants question carries a short flat snippet", () => {
  const q = wantsQuestion({ title: "T", sourceTitle: "S", folder: "F", text: `${"word ".repeat(300)}\n\nmore` });
  assert.equal(q.facts["title"], "T");
  assert.ok(String(q.facts["text"]).length <= 600);
  assert.ok(!String(q.facts["text"]).includes("\n"));
});

test("A typed server is asked for the lane's own model, Jev for its own, and an override wins", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return new Response(JSON.stringify({ model: "m", answers: { answer: { type: "noul", noul: 0.9 }, inverse: { type: "noul", noul: 0.1 } } }), { status: 200 });
  }) as typeof fetch;
  const q = { question: "Same?", facts: { a: "x" } };
  const typed = new SystemOneJudge({ name: "typed", endpoints: [{ name: "typed", baseUrl: "http://typed.test", model: "base-model", local: true }], gate: new EgressGate(), calibrated: false, modelFor: (lane: string) => laneModel("adapter-{lane}", lane), fetch: fetchImpl });
  await typed.yesNo(q, { tier: "public", priority: "background", lane: "same_story" });
  await typed.yesNo(q, { tier: "public", priority: "background" });
  const jev = new SystemOneJudge({ name: "jev", endpoints: [{ name: "jev", baseUrl: "http://jev.test", model: "jev-preview", local: false, apiKey: "k" }], gate: new EgressGate(), calibrated: true, fetch: fetchImpl });
  await jev.yesNo(q, { tier: "public", priority: "background", lane: "same_story" });
  assert.deepEqual(seen, ["adapter-same_story", "base-model", "jev-preview"]);
  assert.equal(laneModel("adapter-{lane}", "wants"), "adapter-wants");

  const logged: JudgmentEntry[] = [];
  const built = buildJudge({ JUHANDU_JUDGE: "typed", JUHANDU_TYPED_ACTS: "1", JUHANDU_TYPED_URLS: "http://typed.test", JUHANDU_TYPED_MODEL: "forced" }, { provider: null, log: (e) => logged.push(e), fetch: fetchImpl });
  await built.judge!.yesNo(q, { tier: "public", priority: "background", lane: "pipe_ask" });
  assert.equal(seen.at(-1), "forced");
  assert.equal(logged[0]!.lane, "pipe_ask");
});

async function serve() {
  const store = new Store(":memory:");
  const app = createApp({ store, ingestor: new Ingestor(store), webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  return { store, base, close: () => new Promise<void>((resolve) => app.close(() => resolve())) };
}

test("the training API shows the status and downloads the rows", async () => {
  const s = await serve();
  try {
    const pub = s.store.addSource({ kind: "feed", url: "https://pub.example/feed", folder: "News", tier: "public" });
    s.store.upsertItems(pub.id, [item("a", "A good one")], NOW);
    s.store.setVote(s.store.listItems({ limit: 5, view: "all", wide: true })[0]!.id, 1, "", NOW);
    s.store.logJudgment(entry({ provider: "jev", probability: 0.9 }), NOW);
    const status = (await (await fetch(`${s.base}/api/training`)).json()) as { lanes: { lane: string; human: number; teacher: number }[]; minHumanTrain: number; logged: unknown[] };
    assert.equal(status.minHumanTrain, MIN_HUMAN_TRAIN);
    assert.equal(status.lanes.find((l) => l.lane === "wants")!.human, 1);
    assert.equal(status.lanes.find((l) => l.lane === "same_story")!.teacher, 1);
    assert.equal(status.logged.length, 1);
    const all = await fetch(`${s.base}/api/training/export`);
    assert.match(all.headers.get("content-type") ?? "", /ndjson/);
    assert.equal((await all.text()).trim().split("\n").length, 2);
    const one = await fetch(`${s.base}/api/training/export?lane=wants`);
    assert.equal((await one.text()).trim().split("\n").length, 1);
    assert.equal((await fetch(`${s.base}/api/training/export?lane=nope`)).status, 400);
  } finally {
    await s.close();
    s.store.close();
  }
});

test("the command line writes the same rows to a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "juhandu-train-"));
  try {
    const store = new Store(join(dir, "juhandu.sqlite"));
    store.logJudgment(entry({ provider: "jev", probability: 0.7 }), NOW);
    store.close();
    const out = join(dir, "rows.jsonl");
    const run = spawnSync(process.execPath, ["src/training/cli.ts", "export", "--lane", "same_story", "--out", out], { env: { ...process.env, JUHANDU_DATA: dir }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { lane: string });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.lane, "same_story");
    const bad = spawnSync(process.execPath, ["src/training/cli.ts", "export", "--lane", "nope"], { env: { ...process.env, JUHANDU_DATA: dir }, encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown lane/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
