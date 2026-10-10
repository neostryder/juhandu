import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, validateCondition } from "../src/rules/rules.ts";
import type { Rule, RuleCondition, RuleItem } from "../src/rules/rules.ts";

const item: RuleItem = { sourceId: 7, url: "https://news.example.com/story/1", folder: "Tech", title: "Sponsored: ten gadgets you need", text: "A look at new phones and laptops", author: "Pat" };

let nextId = 1;
function rule(partial: Partial<Rule> & { condition: RuleCondition }): Rule {
  return { id: nextId++, kind: "block", scope: { type: "all" }, weight: 0, status: "active", origin: "user", note: "", version: 1, createdAt: "", updatedAt: "", ...partial };
}

const keyword = (terms: string[], mode: "any" | "all" = "any"): RuleCondition => ({ type: "keyword", terms, mode, fields: ["title", "text"] });

test("a keyword block hides and records the rule that caused it", () => {
  const block = rule({ condition: keyword(["sponsored"]) });
  const decision = evaluateRules([block], item);
  assert.equal(decision.verdict, "hide");
  assert.equal(decision.hideReason, "block");
  assert.equal(decision.hits[0]!.ruleId, block.id);
  assert.match(decision.hits[0]!.detail, /sponsored/);
});

test("keyword mode all needs every term", () => {
  assert.equal(evaluateRules([rule({ condition: keyword(["phones", "tablets"], "all") })], item).verdict, "show");
  assert.equal(evaluateRules([rule({ condition: keyword(["phones", "laptops"], "all") })], item).verdict, "hide");
});

test("a regex rule matches and an invalid pattern is rejected and never matches", () => {
  assert.equal(evaluateRules([rule({ condition: { type: "regex", pattern: "ten \\w+ you", flags: "i", fields: ["title"] } })], item).verdict, "hide");
  const broken: RuleCondition = { type: "regex", pattern: "([", flags: "", fields: ["title"] };
  assert.match(validateCondition(broken) ?? "", /not a valid/);
  assert.equal(evaluateRules([rule({ condition: broken })], item).verdict, "show");
});

test("a rule can search an item's link, so YouTube Shorts can be hidden by their address", () => {
  const shorts = rule({ condition: { type: "regex", pattern: "youtube\\.com/shorts/", flags: "i", fields: ["url"] } });
  const short = { ...item, url: "https://www.youtube.com/shorts/abc123" };
  const watch = { ...item, url: "https://www.youtube.com/watch?v=abc123" };
  assert.equal(evaluateRules([shorts], short).verdict, "hide");
  assert.equal(evaluateRules([shorts], watch).verdict, "show");
});

test("a pin overrides soft weights but never a hard block", () => {
  const dislike = rule({ kind: "weight", weight: -1, condition: keyword(["gadgets"]) });
  const pin = rule({ kind: "pin", condition: keyword(["laptops"]) });
  assert.equal(evaluateRules([dislike], item).hideReason, "soft");
  const pinned = evaluateRules([dislike, pin], item);
  assert.equal(pinned.verdict, "show");
  assert.equal(pinned.pinned, true);
  const block = rule({ condition: keyword(["sponsored"]) });
  assert.equal(evaluateRules([dislike, pin, block], item).verdict, "hide");
});

test("soft weights add up and hide only past the threshold", () => {
  const a = rule({ kind: "weight", weight: -0.4, condition: keyword(["gadgets"]) });
  const b = rule({ kind: "weight", weight: -0.4, condition: keyword(["phones"]) });
  const c = rule({ kind: "weight", weight: -0.4, condition: keyword(["laptops"]) });
  assert.equal(evaluateRules([a, b], item).verdict, "show");
  const total = evaluateRules([a, b, c], item);
  assert.equal(total.verdict, "hide");
  assert.equal(total.hideReason, "soft");
  assert.ok(Math.abs(total.score + 1.2) < 1e-9);
});

test("scopes limit a rule to a folder or a feed", () => {
  const folder = rule({ scope: { type: "folder", folder: "News" }, condition: keyword(["sponsored"]) });
  const feed = rule({ scope: { type: "source", sourceId: 7 }, condition: keyword(["sponsored"]) });
  assert.equal(evaluateRules([folder], item).verdict, "show");
  assert.equal(evaluateRules([feed], item).verdict, "hide");
});

test("shadow rules are recorded but never applied; disabled rules are skipped", () => {
  const shadow = rule({ status: "shadow", condition: keyword(["sponsored"]) });
  const off = rule({ status: "disabled", condition: keyword(["sponsored"]) });
  const decision = evaluateRules([shadow, off], item);
  assert.equal(decision.verdict, "show");
  assert.equal(decision.hits.length, 1);
  assert.equal(decision.hits[0]!.shadow, true);
});

test("semantic rules match on the evaluator's similarity and report incomplete without an embedding", () => {
  const semantic = rule({ condition: { type: "semantic", sentence: "affiliate shopping lists", examples: [], counterExamples: [], threshold: 0.6 } });
  assert.equal(evaluateRules([semantic], item, () => 0.7).verdict, "hide");
  assert.equal(evaluateRules([semantic], item, () => 0.5).verdict, "show");
  const pending = evaluateRules([semantic], item, () => null);
  assert.equal(pending.verdict, "show");
  assert.equal(pending.incomplete, true);
  assert.equal(evaluateRules([semantic], item).incomplete, true);
});
