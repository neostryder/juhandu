import { test } from "node:test";
import assert from "node:assert/strict";
import { unsafeRegexReason } from "../src/util/regex-safety.ts";
import { evaluateRules, validateCondition } from "../src/rules/rules.ts";
import type { Rule, RuleItem } from "../src/rules/rules.ts";
import { parsePipeDoc } from "../src/pipes/pipe.ts";

const timed = (re: RegExp, text: string): number => {
  const start = performance.now();
  re.test(text);
  return performance.now() - start;
};

test("backreferences and lookaround are refused", () => {
  assert.match(unsafeRegexReason("(a)\\1") ?? "", /Backreferences/);
  assert.match(unsafeRegexReason("(?<n>a)\\k<n>") ?? "", /Named backreferences/);
  assert.match(unsafeRegexReason("a(?=b)") ?? "", /Lookahead/);
  assert.match(unsafeRegexReason("a(?!b)") ?? "", /Lookahead/);
  assert.match(unsafeRegexReason("(?<=a)b") ?? "", /Lookahead/);
  assert.match(unsafeRegexReason("(?<!a)b") ?? "", /Lookahead/);
});

test("ordinary patterns pass, including escaped backslashes, classes, and named groups", () => {
  for (const p of ["^(album|tour)", "\\d{4}-\\d{2}", "[\\1(?=]x", "a\\\\1", "\\(\\?=", "(?<year>\\d{4})", "(?:a|b)+c", "\\bAI\\b"]) {
    assert.equal(unsafeRegexReason(p), null, p);
  }
});

test("nested quantifiers and overlapping alternation finish quickly once the safety module is loaded", () => {
  const bad = "a".repeat(40) + "b";
  assert.ok(timed(new RegExp("^(a+)+$"), bad) < 200);
  assert.ok(timed(new RegExp("^(a|aa)+$"), bad) < 200);
  assert.ok(timed(new RegExp(".*.*.*.*x"), "a".repeat(8000)) < 200);
});

const rule = (pattern: string): Rule =>
  ({ id: 1, name: "r", kind: "block", status: "active", origin: "user", weight: 0, scope: { type: "all" }, condition: { type: "regex", pattern, flags: "i", fields: ["title"] }, createdAt: "", updatedAt: "" }) as unknown as Rule;
const item = { id: 1, sourceId: 1, folder: "", title: "a".repeat(40) + "b", text: "", author: "", url: "https://example.com/x" } as unknown as RuleItem;

test("a regex rule with a backreference is not valid and a stored one never matches", () => {
  const condition = { type: "regex" as const, pattern: "^(a+)+\\1$", flags: "i", fields: ["title" as const] };
  assert.match(validateCondition(condition) ?? "", /Backreferences/);
  const start = performance.now();
  const result = evaluateRules([rule("^(a+)+\\1$")], item, undefined);
  assert.ok(performance.now() - start < 200);
  assert.equal(JSON.stringify(result).includes("regex:"), false);
});

test("a pipe condition with lookahead or a rewrite with a backreference is rejected when the pipe is saved", () => {
  assert.throws(() => parsePipeDoc({ inputs: [{ kind: "all" }], steps: [{ op: "filter", conditions: [{ field: "title", test: "regex", value: "^(?=(a+)+$)x" }] }] }), /Lookahead/);
  assert.throws(() => parsePipeDoc({ inputs: [{ kind: "all" }], steps: [{ op: "rewrite", field: "title", find: "(a)\\1", replace: "x", regex: true }] }), /Backreferences/);
});
