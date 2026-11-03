import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Embedder } from "../src/models/embedder.ts";
import type { ModelProvider } from "../src/models/provider.ts";
import { Processor } from "../src/pipeline/process.ts";
import { Store } from "../src/store/store.ts";
import type { Item, NewItem } from "../src/store/store.ts";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const CONDITION = { type: "keyword" as const, terms: ["match"], mode: "any" as const, fields: ["title" as const] };

function item(guid: string, publishedAt: string | null = NOW.toISOString()): NewItem {
  return { guid, url: `https://x.example/${guid}`, title: `match ${guid}`, author: "", publishedAt, summaryText: "", contentHtml: "", image: "", titleHash: guid, extra: {} };
}

function world(t: TestContext) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const source = store.addSource({ kind: "feed", url: "https://x.example/feed", folder: "Tech" });
  const processor = new Processor(store, null, () => NOW);
  return { store, source, processor };
}

async function serve(t: TestContext, store: Store, processor: Processor) {
  const server = createApp({ store, ingestor: new Ingestor(store), processor, webRoot: "web", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string, body?: unknown) => fetch(base + path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("preview uses the last 30 days, including the boundary and fetched dates for undated items", async (t) => {
  const { store, source, processor } = world(t);
  store.upsertItems(source.id, [item("new"), item("boundary", ago(30).toISOString()), item("old", new Date(ago(30).getTime() - 1).toISOString()), item("undated", null)], ago(2));
  store.upsertItems(source.id, [item("undated-old", null)], ago(31));
  const rows = await processor.preview(CONDITION);
  assert.deepEqual(rows.map((row) => row.title), ["match new", "match undated", "match boundary"]);
  assert.ok(rows.every((row) => row.matched));
});

test("preview caps the window at 1000 items ordered by item date rather than insertion", async (t) => {
  const { store, source, processor } = world(t);
  store.upsertItems(source.id, Array.from({ length: 1002 }, (_, i) => item(String(i), new Date(NOW.getTime() - i * 1000).toISOString())));
  const rows = await processor.preview(CONDITION);
  assert.equal(rows.length, 1000);
  assert.equal(rows[0]!.title, "match 0");
  assert.equal(rows.at(-1)!.title, "match 999");
});

test("preview respects source and folder scope for keyword and semantic conditions", async (t) => {
  const { store, source } = world(t);
  const other = store.addSource({ kind: "feed", url: "https://other.example/feed", folder: "Other" });
  store.upsertItems(source.id, [item("tech")]);
  store.upsertItems(other.id, [item("other")]);
  const provider: ModelProvider = {
    name: "fake", capabilities: { embed: true, chat: false, decide: false, transcribe: false },
    embeddingModel: async () => "test",
    embed: async (request) => ({ model: "test", vectors: request.texts.map(() => new Float32Array([1, 0])) }),
    chat: async () => { throw new Error("unused"); },
    status: async () => ({ name: "fake", ok: true, detail: "", serves: [] }),
  };
  const processor = new Processor(store, new Embedder({ provider }), () => NOW);
  await processor.embedPending();
  const conditions = [CONDITION, { type: "semantic" as const, sentence: "match", examples: [], counterExamples: [], threshold: 0.9 }];
  for (const condition of conditions) {
    for (const scope of [{ type: "source" as const, sourceId: source.id }, { type: "folder" as const, folder: "Tech" }]) {
      const rows = await processor.preview(condition, 1000, scope, "weight");
      assert.deepEqual(rows.map((row) => [row.title, row.matched]), [["match tech", true]]);
    }
  }
});

test("preview counts held matches and new hides, and omits new hides for weight rules", async (t) => {
  const { store, source, processor } = world(t);
  store.upsertItems(source.id, [item("held"), item("restored"), item("shadow"), item("fresh")]);
  store.addRule({ kind: "block", scope: { type: "all" }, condition: { ...CONDITION, terms: ["held", "restored"] } });
  store.addRule({ kind: "block", scope: { type: "all" }, status: "shadow", condition: { ...CONDITION, terms: ["shadow"] } });
  await processor.decidePending();
  const restored = store.listItems().find((row) => row.guid === "restored")!;
  store.restoreItem(restored.id);
  const call = await serve(t, store, processor);
  const preview = await call("/api/rules/preview", { condition: CONDITION });
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.equal(body.days, 30);
  assert.equal(body.total, 4);
  assert.equal(body.matched, 4);
  assert.equal(body.alreadyHeld, 1);
  assert.equal(body.wouldNewlyHide, 3);
  const weight = await (await call("/api/rules/preview", { condition: CONDITION, kind: "weight", scope: { type: "source", sourceId: source.id } })).json();
  assert.equal(weight.alreadyHeld, 1);
  assert.equal(weight.matched, 4);
  assert.equal("wouldNewlyHide" in weight, false);
  const empty = await (await call("/api/rules/preview", { condition: CONDITION, scope: { type: "folder", folder: "Missing" } })).json();
  assert.equal(empty.total, 0);
  assert.equal(empty.wouldNewlyHide, 0);
  const invalid = await call("/api/rules/preview", { condition: CONDITION, kind: "pin" });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /unknown rule kind/);
  assert.equal((await call("/api/rules/preview", { condition: { type: "keyword", terms: [] } })).status, 422);
  assert.equal(store.listRules().length, 2);
  const filtered = await (await call("/api/items?view=filtered")).json();
  assert.deepEqual(filtered.items.map((row: Item) => row.guid), ["held"]);
  const inbox = await (await call("/api/items?view=inbox")).json();
  assert.ok(inbox.items.some((row: Item) => row.guid === "shadow"));
});

test("preview counts all matches before limiting response rows to 100", async (t) => {
  const { store, source, processor } = world(t);
  store.upsertItems(source.id, Array.from({ length: 110 }, (_, i) => item(String(i))));
  const call = await serve(t, store, processor);
  const body = await (await call("/api/rules/preview", { condition: CONDITION })).json();
  assert.equal(body.rows.length, 100);
  assert.equal(body.total, 110);
  assert.equal(body.matched, 110);
  assert.equal(body.wouldNewlyHide, 110);
});

test("count-only preview queries keep older items and insertion order for proposer and list import", async (t) => {
  const { store, source, processor } = world(t);
  store.upsertItems(source.id, [item("new"), item("old", ago(90).toISOString())]);
  assert.deepEqual(store.recentItemsForPreview(1).map((row) => row.title), ["match old"]);
  assert.deepEqual(store.recentItemsForPreview(200).map((row) => row.title), ["match old", "match new"]);
  const proposer = readFileSync(new URL("../src/proposals/proposer.ts", import.meta.url), "utf8");
  assert.match(proposer, /recentItemsForPreview\(200\)/);
  const call = await serve(t, store, processor);
  const body = await (await call("/api/rules/import/preview", { format: "words", text: "old", fields: ["title"] })).json();
  assert.equal(body.wouldHide, 1);
});

interface Element {
  tag: string;
  props: Record<string, any>;
  children: (Element | string)[];
  append: (...children: (Element | string)[]) => void;
}

function element(tag: string, props: Record<string, any> = {}, ...children: (Element | string)[]): Element {
  return { tag, props, children, append(...more) { this.children.push(...more); } };
}

test("held cards link existing rules and keep deleted rule details as text", async (t) => {
  const { store, source, processor } = world(t);
  store.upsertItems(source.id, [item("held")]);
  const rule = store.addRule({ kind: "block", scope: { type: "all" }, condition: { ...CONDITION, terms: ["held"] } });
  await processor.decidePending();
  const call = await serve(t, store, processor);
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const method = app.slice(app.indexOf("  card(item,"), app.indexOf("  /** The phone's bottom"));
  const Cards = runInNewContext(`(class {${method}})`, { el: element, voteControls: () => element("div") }) as new () => { card: (item: Item, filtered: boolean) => Element };
  const cards = new Cards();
  const held = async () => (await (await call("/api/items?view=filtered")).json()).items[0] as Item;
  const reason = (card: Element) => card.children.find((child): child is Element => typeof child !== "string" && child.props.class === "why muted")!;
  const linked = cards.card(await held(), true);
  assert.deepEqual(reason(linked).children.map((child) => typeof child === "string" ? child : [child.tag, child.props.href, child.props.text]), [["a", `#/rules/${rule.id}`, "keyword: held"]]);
  assert.ok(linked.children.some((child) => typeof child !== "string" && child.tag === "button" && child.props.text === "Restore"));
  store.removeRule(rule.id);
  const deleted = cards.card(await held(), true);
  assert.deepEqual(reason(deleted).children, ["keyword: held"]);
});

test("rule links open Rules and focus and scroll the row before opening its editor", async () => {
  const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(app, /open\("rules", rules,.*element\.openRule/);
  const rules = readFileSync(new URL("../web/rules.js", import.meta.url), "utf8");
  const method = rules.slice(rules.indexOf("  async openRule("), rules.indexOf("  renderList()"));
  const calls: string[] = [];
  const Screen = runInNewContext(`(class {${method}})`) as new () => { openRule: (id: string) => Promise<void> };
  const screen = Object.assign(new Screen(), {
    rules: [{ id: 14 }], load: async () => { calls.push("load"); },
    $: (id: string) => { assert.equal(id, "rule14"); return { scrollIntoView: () => calls.push("scroll"), focus: () => calls.push("focus") }; },
    edit: (rule: { id: number }) => { assert.equal(rule.id, 14); calls.push("edit"); },
  });
  await screen.openRule("14");
  assert.deepEqual(calls, ["load", "scroll", "focus", "edit"]);
  calls.length = 0;
  await screen.openRule("999");
  assert.deepEqual(calls, ["load"]);
  assert.match(rules, /scope: readScope\(\), kind: previewKind/);
  assert.match(rules, /scopeValue\.addEventListener\("change", schedulePreview\)/);
});
