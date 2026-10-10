// Pipes: a pipe is one declarative JSON document, so the form editor today and a graph editor later read and write the same thing.
// A pipe takes items in (everything, a folder, one feed, or another pipe), runs ordered steps, and its output is a feed. Rules hide and boost inside Reading; a pipe makes a new stream and never touches the originals.

export type PipeInput = { kind: "all" } | { kind: "folder"; name: string } | { kind: "feed"; id: number } | { kind: "pipe"; id: number };

export const FIELDS = ["title", "text", "author", "url", "source", "folder", "tag"] as const;
export type Field = (typeof FIELDS)[number];

export const TESTS = ["contains", "not-contains", "equals", "starts-with", "regex"] as const;
export type Test = (typeof TESTS)[number];

export interface Condition {
  field: Field;
  test: Test;
  value: string;
}

/** Fields a rewrite step may change. */
export const REWRITE_FIELDS = ["title", "text", "url", "author"] as const;
export type RewriteField = (typeof REWRITE_FIELDS)[number];

export type PipeStep =
  | { op: "filter"; keep: boolean; match: "any" | "all"; conditions: Condition[] }
  | { op: "newer-than"; days: number }
  | { op: "dedupe"; by: "url" | "title" }
  | { op: "sort"; by: "date" | "title" | "source"; order: "asc" | "desc" }
  | { op: "limit"; count: number; perSource: boolean }
  | { op: "rewrite"; field: RewriteField; find: string; replace: string; regex: boolean }
  | { op: "tag"; tag: string }
  | { op: "summary" }
  | { op: "ask"; question: string; keep: "yes" | "no" };

export interface PipeOutputSettings {
  limit: number;
  /** Serve the output as a feed at /pipes/<slug>.xml. Never allowed for a pipe that reads a private feed. */
  publish: boolean;
}

export interface PipeDoc {
  version: 1;
  inputs: PipeInput[];
  steps: PipeStep[];
  output: PipeOutputSettings;
}

export const LIMITS = { inputs: 50, steps: 30, conditions: 20, value: 500, pattern: 300, question: 500, tag: 40, output: 500, ask: 3 } as const;

export const OPS = ["filter", "newer-than", "dedupe", "sort", "limit", "rewrite", "tag", "summary", "ask"] as const;

function str(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  if (value.length > max) throw new Error(`${label} is too long`);
  if (required && !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) throw new Error(`${label} must be one of: ${choices.join(", ")}`);
  return value as T;
}

function whole(value: unknown, label: string, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}`);
  return n;
}

function checkPattern(pattern: string, label: string): void {
  if (!pattern) throw new Error(`${label} needs a pattern`);
  if (pattern.length > LIMITS.pattern) throw new Error(`${label} is too long`);
  try {
    new RegExp(pattern, "i");
  } catch {
    throw new Error(`${label} is not a valid regular expression`);
  }
}

function readInput(raw: unknown): PipeInput {
  if (!raw || typeof raw !== "object") throw new Error("An input must be an object");
  const r = raw as Record<string, unknown>;
  switch (r["kind"]) {
    case "all":
      return { kind: "all" };
    case "folder":
      return { kind: "folder", name: str(r["name"], "The folder name", 80) };
    case "feed":
      return { kind: "feed", id: whole(r["id"], "The feed", 1, Number.MAX_SAFE_INTEGER) };
    case "pipe":
      return { kind: "pipe", id: whole(r["id"], "The pipe", 1, Number.MAX_SAFE_INTEGER) };
    default:
      throw new Error("An input must be everything, a folder, a feed or a pipe");
  }
}

function readCondition(raw: unknown): Condition {
  if (!raw || typeof raw !== "object") throw new Error("A condition must be an object");
  const r = raw as Record<string, unknown>;
  const test = oneOf(r["test"], TESTS, "A condition's test");
  const value = str(r["value"], "A condition's value", LIMITS.value, true);
  if (test === "regex") checkPattern(value, "A condition");
  return { field: oneOf(r["field"], FIELDS, "A condition's field"), test, value };
}

function readStep(raw: unknown): PipeStep {
  if (!raw || typeof raw !== "object") throw new Error("A step must be an object");
  const r = raw as Record<string, unknown>;
  const op = oneOf(r["op"], OPS, "A step's kind");
  switch (op) {
    case "filter": {
      const conditions = Array.isArray(r["conditions"]) ? r["conditions"].map(readCondition) : [];
      if (!conditions.length) throw new Error("A filter needs at least one condition");
      if (conditions.length > LIMITS.conditions) throw new Error(`A filter can have at most ${LIMITS.conditions} conditions`);
      return { op, keep: r["keep"] !== false, match: oneOf(r["match"] ?? "any", ["any", "all"] as const, "A filter's match"), conditions };
    }
    case "newer-than":
      return { op, days: whole(r["days"], "The number of days", 1, 3650) };
    case "dedupe":
      return { op, by: oneOf(r["by"] ?? "url", ["url", "title"] as const, "Dedupe by") };
    case "sort":
      return { op, by: oneOf(r["by"] ?? "date", ["date", "title", "source"] as const, "Sort by"), order: oneOf(r["order"] ?? "desc", ["asc", "desc"] as const, "The sort order") };
    case "limit":
      return { op, count: whole(r["count"], "The limit", 1, LIMITS.output), perSource: r["perSource"] === true };
    case "rewrite": {
      const regex = r["regex"] === true;
      const find = str(r["find"], "The text to find", LIMITS.pattern, true);
      if (regex) checkPattern(find, "A rewrite");
      return { op, field: oneOf(r["field"], REWRITE_FIELDS, "The field to rewrite"), find, replace: str(r["replace"], "The replacement", LIMITS.value), regex };
    }
    case "tag": {
      const tag = str(r["tag"], "The tag", LIMITS.tag, true).trim();
      if (/[\r\n]/.test(tag)) throw new Error("A tag cannot contain a line break");
      return { op, tag };
    }
    case "summary":
      return { op };
    case "ask":
      return { op, question: str(r["question"], "The question", LIMITS.question, true).trim(), keep: oneOf(r["keep"] ?? "yes", ["yes", "no"] as const, "Keep the items answered") };
  }
}

/** Checks and normalizes a document from the API. Throws an Error with a readable message. */
export function parsePipeDoc(raw: unknown): PipeDoc {
  if (!raw || typeof raw !== "object") throw new Error("A pipe must be an object");
  const r = raw as Record<string, unknown>;
  const inputs = Array.isArray(r["inputs"]) ? r["inputs"].map(readInput) : [];
  if (!inputs.length) throw new Error("A pipe needs at least one input");
  if (inputs.length > LIMITS.inputs) throw new Error(`A pipe can have at most ${LIMITS.inputs} inputs`);
  const steps = Array.isArray(r["steps"]) ? r["steps"].map(readStep) : [];
  if (steps.length > LIMITS.steps) throw new Error(`A pipe can have at most ${LIMITS.steps} steps`);
  if (steps.filter((s) => s.op === "ask").length > LIMITS.ask) throw new Error(`A pipe can have at most ${LIMITS.ask} questions for the AI`);
  const out = r["output"] && typeof r["output"] === "object" ? (r["output"] as Record<string, unknown>) : {};
  return { version: 1, inputs, steps, output: { limit: out["limit"] === undefined ? 100 : whole(out["limit"], "The output limit", 1, LIMITS.output), publish: out["publish"] === true } };
}

/** A URL-safe name for a pipe's feed address. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return slug || "pipe";
}
