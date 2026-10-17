import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Briefer, renderMarkdown } from "../src/briefing/briefer.ts";
import { buildDigest } from "../src/notify/digest.ts";
import { StoryBuilder } from "../src/briefing/stories.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import type { Judge, PickQuestion, YesNoQuestion } from "../src/judges/judge.ts";
import { NoEndpointError } from "../src/models/pool.ts";
import type { ChatRequest, ModelProvider } from "../src/models/provider.ts";
import { Processor } from "../src/pipeline/process.ts";
import { Store } from "../src/store/store.ts";
import type { NewItem } from "../src/store/store.ts";

const NOW = new Date("2026-10-06T12:00:00Z");

function item(guid: string, title: string, text: string, publishedAt = "2026-10-06T08:00:00Z"): NewItem {
  return { guid, url: `https://x.example/${guid}`, title, author: "", publishedAt, summaryText: text, contentHtml: "", image: "", titleHash: guid, extra: {} };
}

const RPG_A = "Starfall Chronicles review: a sprawling space RPG that nails companion writing but stumbles on its crafting systems and late game pacing.";
const RPG_B = "Starfall Chronicles verdict: the new space RPG has superb companions, weaker crafting and a late game that drags on for hours.";
const OTHER = "A different story about something else entirely, with enough words to count as a real body of text for the summarizer to work with.";

interface Fixture {
  store: Store;
  ids: Record<string, number>;
}

async function fixture(): Promise<Fixture> {
  const store = new Store(":memory:");
  const ign = store.addSource({ kind: "feed", url: "https://ign.example/feed", folder: "Games" });
  const spot = store.addSource({ kind: "feed", url: "https://spot.example/feed", folder: "Games" });
  const tech = store.addSource({ kind: "feed", url: "https://tech.example/feed", folder: "Tech" });
  store.upsertItems(ign.id, [item("ign1", "Starfall Chronicles review", RPG_A), item("ign2", "Cozy farm sim announced", OTHER), item("ign3", "Pinned: Studio news", OTHER)]);
  store.upsertItems(spot.id, [item("spot1", "Starfall Chronicles: our verdict", RPG_B), item("spot2", "Old news", OTHER, "2026-09-01T08:00:00Z")]);
  store.upsertItems(tech.id, [item("tech1", "New chip announced", OTHER), item("tech2", "Sponsored gadget list", OTHER)]);
  store.addRule({ kind: "block", scope: { type: "all" }, condition: { type: "keyword", terms: ["sponsored"], mode: "any", fields: ["title"] } });
  store.addRule({ kind: "pin", scope: { type: "all" }, condition: { type: "keyword", terms: ["pinned"], mode: "any", fields: ["title"] } });
  await new Processor(store, null, () => NOW).decidePending();
  const ids = Object.fromEntries(store.listItems({ limit: 100 }).map((i) => [i.guid, i.id]));
  const vectors: Record<string, number[]> = { ign1: [1, 0, 0, 0], spot1: [1, 0, 0, 0], ign2: [0, 1, 0, 0], ign3: [0, 0, 1, 0], spot2: [1, 0, 0, 0], tech1: [0, 0, 0, 1], tech2: [1, 0, 0, 0] };
  for (const [guid, v] of Object.entries(vectors)) store.saveEmbedding(ids[guid]!, "tag", Float32Array.from(v), NOW);
  return { store, ids };
}

function fakeJudge(answer: (q: YesNoQuestion) => boolean | Error, asked: YesNoQuestion[] = []): Judge {
  return {
    yesNo: async (q) => {
      asked.push(q);
      const out = answer(q);
      if (out instanceof Error) throw out;
      return { answer: out, probability: out ? 0.95 : 0.05, calibrated: true, model: "fake" };
    },
    pickOne: async (_q: PickQuestion) => {
      throw new Error("unused");
    },
    rank: async (_q: PickQuestion) => {
      throw new Error("unused");
    },
  };
}

function summaryProvider(reply: (request: ChatRequest) => string | Error, seen: ChatRequest[] = []): ModelProvider {
  return {
    name: "fake",
    capabilities: { embed: false, chat: true, decide: false, transcribe: false },
    embeddingModel: async () => null,
    embed: async () => {
      throw new Error("unused");
    },
    chat: async (request) => {
      seen.push(request);
      const out = reply(request);
      if (out instanceof Error) throw out;
      return { text: out, model: "fake-model" };
    },
    status: async () => ({ name: "fake", ok: true, detail: "", serves: [] }),
  };
}

const mergedLine = () => JSON.stringify({ summary: "Starfall Chronicles earns praise for companions but criticism for crafting and late-game pacing.", evidence: "superb companions, weaker crafting" });

function builder(store: Store, judge: Judge, provider = summaryProvider(mergedLine)): StoryBuilder {
  return new StoryBuilder({ store, provider, judge, tag: async () => "tag", clock: () => NOW });
}

test("the same story from two sources is merged once the Judge agrees, and never within one source", async () => {
  const { store, ids } = await fixture();
  const asked: YesNoQuestion[] = [];
  const run = await builder(store, fakeJudge(() => true, asked)).run("background");
  assert.equal(run.merged, 1);
  assert.equal(run.storiesSummarized, 1);
  const pairs = asked.map((q) => [q.facts["item_a_title"], q.facts["item_b_title"]].sort().join(" | "));
  assert.ok(pairs.every((p) => !p.includes("Cozy farm sim") || p.includes("New chip announced")), "only cross-source pairs are asked");
  const rpg = store.mergePool("tag", 0).filter((p) => p.id === ids["ign1"] || p.id === ids["spot1"]);
  assert.equal(rpg[0]!.storyId, rpg[1]!.storyId);
  assert.notEqual(rpg[0]!.storyId, null);
  const story = store.getStory(rpg[0]!.storyId!)!;
  assert.equal(story.verified, true);
  assert.match(story.summary, /Starfall/);
  const again = await builder(store, fakeJudge(() => true, asked)).run("background");
  assert.equal(again.checked, 0, "checked items are not asked about again");
  store.close();
});

test("a no from the Judge keeps stories apart", async () => {
  const { store } = await fixture();
  const run = await builder(store, fakeJudge(() => false)).run("background");
  assert.equal(run.merged, 0);
  assert.equal(store.mergePool("tag", 0).every((p) => p.storyId === null), true);
  store.close();
});

test("with no model the merge waits and a later run catches up", async () => {
  const { store } = await fixture();
  let up = false;
  const stories = builder(store, fakeJudge(() => (up ? true : new NoEndpointError("down"))));
  const down = await stories.run("background");
  assert.ok(down.queued > 0);
  assert.equal(down.merged, 0);
  up = true;
  assert.equal((await stories.run("background")).merged, 1);
  store.close();
});

test("a made-up merged line is flagged and a bad reply is retried then dropped to member lines", async () => {
  const { store } = await fixture();
  const invented = summaryProvider(() => JSON.stringify({ summary: "Starfall is cancelled.", evidence: "the game was cancelled yesterday afternoon" }));
  await builder(store, fakeJudge(() => true), invented).run("background");
  const storyId = store.mergePool("tag", 0).find((p) => p.storyId !== null)!.storyId!;
  assert.equal(store.getStory(storyId)!.verified, false);

  const broken = await fixture();
  const stories = builder(broken.store, fakeJudge(() => true), summaryProvider(() => "not json"));
  for (let i = 0; i < 5; i++) await stories.run("background");
  assert.equal(broken.store.staleStoryIds(10).length, 0, "after three tries the story stops being retried");
  store.close();
  broken.store.close();
});

test("a briefing groups unread shown items by folder, merges stories, ranks pins first and caps each folder", async () => {
  const { store, ids } = await fixture();
  await builder(store, fakeJudge(() => true)).run("background");
  for (const guid of ["ign2", "ign3", "tech1"]) store.saveSummary(ids[guid]!, { status: "ok", text: `Summary of ${guid}.`, evidence: "x y z", verified: true, model: "m", promptVersion: 1 }, NOW);
  const briefer = new Briefer(store, () => NOW);
  const daily = briefer.build({ kind: "daily" });
  assert.deepEqual(daily.sections.map((s) => s.folder), ["Games", "Tech"], "the folder with the pinned item leads");
  const games = daily.sections[0]!;
  assert.equal(games.entries[0]!.pinned, true);
  const story = games.entries.find((e) => e.kind === "story")!;
  assert.equal(story.links.length, 2);
  assert.deepEqual(story.links.map((l) => l.url).sort(), ["https://x.example/ign1", "https://x.example/spot1"]);
  assert.equal(daily.itemCount, 5, "the blocked item is not counted and the month-old one is outside the window");
  assert.equal(daily.sections.flatMap((s) => s.entries).some((e) => e.text.includes("Sponsored")), false);
  const capped = briefer.build({ kind: "daily", perFolder: 1 });
  assert.equal(capped.sections[0]!.entries.length, 1);
  assert.equal(capped.sections[0]!.omitted, 2);
  const catchup = briefer.build({ kind: "catchup" });
  assert.equal(catchup.itemCount, 6, "a catch-up briefing reaches back past the daily window");
  assert.equal(briefer.get(daily.id)!.sections.length, 2);
  store.setVote(ids["ign2"]!, -1, "");
  store.setRead(ids["tech1"]!, true);
  assert.equal(briefer.build({ kind: "daily" }).itemCount, 3, "voted-down and read items drop out");
  store.close();
});

test("the markdown rendering carries a source link on every line", async () => {
  const { store } = await fixture();
  await builder(store, fakeJudge(() => true)).run("background");
  const md = renderMarkdown(new Briefer(store, () => NOW).build({ kind: "daily" }));
  const lines = md.split("\n").filter((l) => l.startsWith("- ") && !l.includes("more in this folder"));
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => /\]\(https:\/\/x\.example\//.test(l)));
  assert.match(md, /^## Games$/m);
  store.close();
});

test("briefings can be built, read and marked read over the API", async () => {
  const { store } = await fixture();
  const server = createApp({ store, ingestor: new Ingestor(store), briefer: new Briefer(store, () => NOW), webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const created = (await (await post("/api/briefings", { kind: "daily" })).json()) as { briefing: { id: number; itemCount: number } };
  assert.equal(created.briefing.itemCount, 5);
  const md = await fetch(`${base}/api/briefings/${created.briefing.id}?format=md`);
  assert.match(md.headers.get("content-type") ?? "", /markdown/);
  assert.match(await md.text(), /^# Briefing/);
  assert.equal(((await (await fetch(`${base}/api/briefings`)).json()) as { briefings: unknown[] }).briefings.length, 1);
  const marked = (await (await post(`/api/briefings/${created.briefing.id}/read`)).json()) as { marked: number };
  assert.equal(marked.marked, 5);
  assert.equal(store.listItems({ unreadOnly: true, limit: 100 }).filter((i) => i.decision?.verdict === "show").length, 1, "only the old item is still unread");
  assert.equal((await fetch(`${base}/api/briefings/999`)).status, 404);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

test("a merged story line written from a story with a private member is withheld outside the app, even when that member is not in the briefing", async () => {
  const store = new Store(":memory:");
  const a = store.addSource({ kind: "feed", url: "https://a.example/feed", folder: "Games" });
  const b = store.addSource({ kind: "feed", url: "https://b.example/feed", folder: "Games" });
  const secret = store.addSource({ kind: "feed", url: "https://c.example/feed", folder: "Games", tier: "private" });
  store.upsertItems(a.id, [item("a1", "Starfall Chronicles review", RPG_A)]);
  store.upsertItems(b.id, [item("b1", "Starfall Chronicles: our verdict", RPG_B)]);
  store.upsertItems(secret.id, [item("c1", "Starfall Chronicles, private notes", RPG_B)]);
  await new Processor(store, null, () => NOW).decidePending();
  const ids = Object.fromEntries(store.listItems({ limit: 100 }).map((i) => [i.guid, i.id]));
  store.setRead(ids["c1"]!, true);
  const storyId = store.createStory([ids["a1"]!, ids["b1"]!, ids["c1"]!], NOW);
  store.saveStorySummary(storyId, { text: "Starfall Chronicles is reviewed.", evidence: "superb companions", verified: true, model: "m" }, NOW);
  const briefing = new Briefer(store, () => NOW).build({ kind: "daily" });
  const entry = briefing.sections.flatMap((s) => s.entries).find((e) => e.kind === "story")!;
  assert.deepEqual(entry.links.map((l) => l.id).sort(), [ids["a1"]!, ids["b1"]!].sort(), "the private member is not linked");
  assert.equal(entry.private, true);
  const tiers = store.itemTiers(entry.links.map((l) => l.id));
  const outside = buildDigest(briefing, tiers, { includePrivate: false });
  assert.equal(outside.entryCount, 0);
  assert.equal(outside.withheld, 1);
  assert.equal(buildDigest(briefing, tiers, { includePrivate: true }).entryCount, 1);
  const old = JSON.parse(JSON.stringify(briefing)) as typeof briefing;
  delete old.sections[0]!.entries.find((e) => e.kind === "story")!.private;
  assert.equal(buildDigest(old, tiers, { includePrivate: false }).entryCount, 0, "a story line saved before the field existed counts as private");
  store.close();
});
