import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { parseList, planImport, previewList } from "../src/rules/blocklist.ts";
import type { ListItem } from "../src/rules/blocklist.ts";
import { evaluateRules, hostOf, matchDomain, validateCondition } from "../src/rules/rules.ts";
import type { Rule, RuleItem } from "../src/rules/rules.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Processor } from "../src/pipeline/process.ts";
import { Store } from "../src/store/store.ts";
import type { NewItem } from "../src/store/store.ts";

const NOW = new Date("2026-10-06T12:00:00Z");

test("a word list skips comments and blanks, keeps hashtags, and drops case-insensitive duplicates and over-long lines", () => {
  const parsed = parseList("words", ["# my mute list", "", "Sponsored", "sponsored", "#hashtag", "  best   deals  ", "// note", "x".repeat(200)].join("\n"));
  assert.deepEqual(parsed.entries, ["Sponsored", "#hashtag", "best deals"]);
  assert.equal(parsed.skipped.length, 1);
  assert.match(parsed.skipped[0]!.reason, /longer than/);
});

test("a domain list reads hosts-file lines, adblock rules, wildcards and URLs, and says why it skipped a line", () => {
  const parsed = parseList(
    "domains",
    [
      "[Adblock Plus 2.0]",
      "! comment",
      "# comment",
      "0.0.0.0 ads.example.com",
      "127.0.0.1 tracker.test # inline",
      "||news-spam.example^$third-party",
      "*.clickbait.example",
      "https://www.Outrage.example/path?q=1",
      "plain.example",
      "plain.example",
      "@@||allowed.example^",
      "localhost",
      "192.168.0.1",
      "not a domain",
    ].join("\n"),
  );
  assert.deepEqual(parsed.entries, ["ads.example.com", "tracker.test", "news-spam.example", "clickbait.example", "www.outrage.example", "plain.example"]);
  assert.deepEqual(
    parsed.skipped.map((s) => s.reason.replace(/ which.*/, "")),
    ["an exception rule, which is not supported", "not a domain name", "not a domain name", "not a domain name"].map((r) => r.replace(/ which.*/, "")),
  );
});

test("a domain rule matches the host and its subdomains but not look-alike names", () => {
  const condition = { type: "domain" as const, domains: ["example.com", "ads.other.net"] };
  assert.equal(matchDomain(condition, "example.com"), "example.com");
  assert.equal(matchDomain(condition, "news.example.com"), "example.com");
  assert.equal(matchDomain(condition, "notexample.com"), null);
  assert.equal(matchDomain(condition, "other.net"), null);
  assert.equal(matchDomain(condition, "x.ads.other.net"), "ads.other.net");
  assert.equal(hostOf("https://News.Example.com./a"), "news.example.com");
  assert.equal(hostOf("javascript:alert(1)"), "");
  assert.equal(validateCondition({ type: "domain", domains: [] }), "A domain rule needs at least one domain");
  assert.match(validateCondition({ type: "domain", domains: ["not a domain"] }) ?? "", /example\.com/);
  const rule: Rule = { id: 1, kind: "block", scope: { type: "all" }, condition, weight: 0, status: "active", origin: "user", note: "", version: 1, createdAt: "", updatedAt: "" };
  const item: RuleItem = { sourceId: 1, url: "https://blog.example.com/post", folder: "", title: "t", text: "", author: "" };
  const decision = evaluateRules([rule], item);
  assert.equal(decision.verdict, "hide");
  assert.equal(decision.hits[0]!.detail, "domain: example.com");
});

const items: ListItem[] = [
  { id: 1, title: "Sponsored: ten gadgets", text: "buy now", author: "", url: "https://shop.example.com/1" },
  { id: 2, title: "A calm essay", text: "about sponsored research", author: "", url: "https://essays.test/2" },
  { id: 3, title: "Rust trait solver", text: "nightly", author: "", url: "https://blog.rust-lang.org/3" },
];

test("a preview counts what each entry would hide and how many items the whole list hides", () => {
  const words = previewList("words", ["sponsored", "nightly", "absent"], items, ["title", "text"]);
  assert.deepEqual(words.entries.map((e) => [e.entry, e.matched]), [["sponsored", 2], ["nightly", 1], ["absent", 0]]);
  assert.equal(words.wouldHide, 3);
  assert.equal(previewList("words", ["sponsored"], items, ["title"]).wouldHide, 1, "only the chosen fields are searched");
  const domains = previewList("domains", ["example.com", "rust-lang.org"], items, []);
  assert.deepEqual(domains.entries.map((e) => [e.entry, e.matched]), [["example.com", 1], ["rust-lang.org", 1]]);
  assert.equal(domains.entries[0]!.titles[0], "Sponsored: ten gadgets");
});

test("an import plan makes one rule or one per line and leaves out what a block rule already holds", () => {
  const base = { format: "words" as const, name: "Mute list", scope: { type: "all" as const }, fields: ["title" as const] };
  const existing = [{ kind: "block", status: "active", condition: { type: "keyword", terms: ["Sponsored"] } }, { kind: "block", status: "disabled", condition: { type: "keyword", terms: ["nightly"] } }];
  const list = planImport(["sponsored", "nightly", "deals"], { ...base, group: "list" }, existing);
  assert.equal(list.rules.length, 1);
  assert.deepEqual(list.alreadyCovered, ["sponsored"]);
  assert.deepEqual((list.rules[0]!.condition as { terms: string[] }).terms, ["nightly", "deals"], "a disabled rule does not cover its terms");
  assert.equal(list.rules[0]!.note, "Mute list");
  const each = planImport(["a", "b", "c"], { ...base, group: "each" }, []);
  assert.deepEqual(each.rules.map((r) => (r.condition as { terms: string[] }).terms), [["a"], ["b"], ["c"]]);
  const many = planImport(Array.from({ length: 600 }, (_, i) => `w${i}`), { ...base, group: "each" }, []);
  assert.equal(many.rules.length, 1, "a very long list stays one rule");
  assert.equal(planImport(["x.example.com"], { ...base, format: "domains", group: "list" }, [{ kind: "block", status: "active", condition: { type: "domain", domains: ["x.example.com"] } }]).rules.length, 0);
});

function item(guid: string, title: string, url: string, text = "body text that is long enough"): NewItem {
  return { guid, url, title, author: "", publishedAt: "2026-10-06T08:00:00Z", summaryText: text, contentHtml: "", image: "", titleHash: guid, extra: {} };
}

async function serve(): Promise<{ base: string; store: Store; close: () => Promise<void> }> {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://feed.example/rss", folder: "Tech" });
  store.upsertItems(source.id, [item("a", "Sponsored: ten gadgets", "https://shop.example.com/1"), item("b", "Rust trait solver", "https://blog.rust-lang.org/3"), item("c", "A calm essay", "https://essays.test/2", "about sponsored research")]);
  const processor = new Processor(store, null, () => NOW);
  await processor.decidePending();
  const server = createApp({ store, ingestor: new Ingestor(store), processor, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a pasted list is previewed, then imported with unticked lines left out, and importing it twice adds nothing", async () => {
  const { base, store, close } = await serve();
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const text = ["# list", "sponsored", "nightly", "never-matches"].join("\n");
  const preview = await post("/api/rules/import/preview", { format: "words", text, fields: ["title"] });
  assert.equal(preview.status, 200);
  assert.equal(preview.body["entryCount"], 3);
  assert.equal(preview.body["wouldHide"], 1);
  assert.deepEqual(preview.body["matching"].map((m: { entry: string }) => m.entry), ["sponsored"]);
  assert.equal(preview.body["unmatchedCount"], 2);
  assert.equal(store.listRules().length, 0, "a preview creates nothing");

  const imported = await post("/api/rules/import", { format: "words", text, fields: ["title"], name: "My mutes", exclude: ["nightly"], group: "list" });
  assert.equal(imported.status, 201);
  assert.equal(imported.body["created"], 1);
  assert.equal(imported.body["imported"], 2);
  const rule = store.listRules()[0]!;
  assert.deepEqual(rule.condition, { type: "keyword", terms: ["sponsored", "never-matches"], mode: "any", fields: ["title"] });
  assert.equal(rule.note, "My mutes");
  assert.equal(store.listItems({ view: "filtered", limit: 10 }).length, 1, "the rule acted at once");

  const again = await post("/api/rules/import", { format: "words", text, fields: ["title"], exclude: ["nightly"] });
  assert.equal(again.body["created"], 0);
  assert.equal(again.body["alreadyCovered"], 2);

  const rules = (await (await fetch(base + "/api/rules")).json()) as { rules: { id: number; matched: number }[] };
  assert.equal(rules.rules[0]!.matched, 1, "the rule list reports how many items each rule matched");
  assert.equal((await post("/api/rules/import", { format: "words", text: "  \n" })).status, 400);
  assert.equal((await post("/api/rules/import", { format: "domains", text: "not a domain" })).status, 422);
  assert.equal((await post("/api/rules/import", { format: "words", text, exclude: ["sponsored", "nightly", "never-matches"] })).status, 422);
  await close();
  store.close();
});

test("a domain list is imported as one domain rule that hides items by their link, even past the usual body limit", async () => {
  const { base, store, close } = await serve();
  const filler = Array.from({ length: 5000 }, (_, i) => `0.0.0.0 filler-${i}.example.net`).join("\n");
  const text = `${filler}\n||example.com^\n`;
  assert.ok(text.length > 64 * 1024);
  const response = await fetch(base + "/api/rules/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ format: "domains", text, name: "Ad hosts" }) });
  assert.equal(response.status, 201);
  const rule = store.listRules()[0]!;
  assert.equal(rule.condition.type, "domain");
  assert.equal((rule.condition as { domains: string[] }).domains.length, 5001);
  const hidden = store.listItems({ view: "filtered", limit: 10 });
  assert.deepEqual(hidden.map((i) => i.title), ["Sponsored: ten gadgets"]);
  const created = await fetch(base + "/api/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "block", condition: { type: "domain", domains: ["rust-lang.org"] } }) });
  assert.equal(created.status, 201);
  assert.equal(store.listItems({ view: "filtered", limit: 10 }).length, 2);
  await close();
  store.close();
});
