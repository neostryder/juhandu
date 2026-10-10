// Runs pipes. A pipe's output is worked out when it is asked for, from the items already stored, so it never lags behind and nothing is copied.
// The one slow step is a question for the AI: answers are stored per question and item, a background pass fills them in, and items still waiting are held back from the output (never dropped).
import { createHash } from "node:crypto";
import type { Judge } from "../judges/judge.ts";
import { NoEndpointError } from "../models/pool.ts";
import type { Priority } from "../models/provider.ts";
import type { DataTier, Item, Store } from "../store/store.ts";
import type { Condition, PipeDoc, PipeStep } from "./pipe.ts";

export interface PipeEntry {
  itemId: number;
  sourceId: number;
  source: string;
  folder: string;
  url: string;
  title: string;
  author: string;
  /** The feed's own text for the item. */
  text: string;
  /** The stored one-line summary, when there is one. */
  summary: string;
  publishedAt: string | null;
  /** When the item can be ordered by: its date, else when it was fetched. */
  at: string;
  tags: string[];
  tier: DataTier;
}

export interface PipeResult {
  entries: PipeEntry[];
  counts: { gathered: number; output: number; waiting: number };
  /** private when any input is a private feed: such a pipe is never published and only local models read its text. */
  tier: DataTier;
  notes: string[];
}

export interface PendingAsk {
  key: string;
  question: string;
  entries: PipeEntry[];
}

interface RunOptions {
  stack?: number[];
  /** Collects the items each question is still waiting to be asked about. */
  pending?: Map<string, PendingAsk>;
}

const GATHER_LIMIT = 600;
const MAX_DEPTH = 5;

export const askKey = (question: string): string => createHash("sha1").update(question.trim().toLowerCase()).digest("hex").slice(0, 20);

const regexCache = new Map<string, RegExp | null>();
function compile(pattern: string, flags: string): RegExp | null {
  const key = `${flags}/${pattern}`;
  if (regexCache.has(key)) return regexCache.get(key) ?? null;
  let re: RegExp | null = null;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    re = null;
  }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(key, re);
  return re;
}

function toEntry(item: Item, folder: string, tier: DataTier): PipeEntry {
  return {
    itemId: item.id,
    sourceId: item.sourceId,
    source: item.sourceTitle,
    folder,
    url: item.url,
    title: item.title,
    author: item.author,
    text: item.summaryText,
    summary: item.summary?.text ?? "",
    publishedAt: item.publishedAt,
    at: item.publishedAt ?? item.fetchedAt,
    tags: [],
    tier,
  };
}

function fieldValues(entry: PipeEntry, field: Condition["field"]): string[] {
  switch (field) {
    case "title":
      return [entry.title];
    case "text":
      return [entry.summary ? `${entry.text}\n${entry.summary}` : entry.text];
    case "author":
      return [entry.author];
    case "url":
      return [entry.url];
    case "source":
      return [entry.source];
    case "folder":
      return [entry.folder];
    case "tag":
      return entry.tags;
  }
}

function conditionHolds(condition: Condition, entry: PipeEntry): boolean {
  const values = fieldValues(entry, condition.field);
  const needle = condition.value.toLowerCase();
  switch (condition.test) {
    case "contains":
      return values.some((v) => v.toLowerCase().includes(needle));
    case "not-contains":
      return !values.some((v) => v.toLowerCase().includes(needle));
    case "equals":
      return values.some((v) => v.trim().toLowerCase() === needle.trim());
    case "starts-with":
      return values.some((v) => v.trim().toLowerCase().startsWith(needle.trim()));
    case "regex": {
      const re = compile(condition.value, "i");
      return !!re && values.some((v) => re.test(v.slice(0, 20_000)));
    }
  }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function snippet(text: string, chars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > chars ? `${flat.slice(0, chars)}...` : flat;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PipeEngine {
  private readonly store: Store;
  private readonly judge: Judge | null;

  constructor(deps: { store: Store; judge?: Judge | null }) {
    this.store = deps.store;
    this.judge = deps.judge ?? null;
  }

  /** Works out a pipe's output. Throws when the pipe reads itself through other pipes. */
  evaluate(doc: PipeDoc, options: RunOptions = {}): PipeResult {
    const notes: string[] = [];
    const { entries: gathered, tier } = this.gather(doc, options, notes);
    let entries = gathered;
    let waiting = 0;
    for (const step of doc.steps) {
      const result = this.apply(step, entries, options, notes);
      entries = result.entries;
      waiting += result.waiting;
    }
    const output = entries.slice(0, doc.output.limit);
    return { entries: output, counts: { gathered: gathered.length, output: output.length, waiting }, tier, notes: [...new Set(notes)] };
  }

  private gather(doc: PipeDoc, options: RunOptions, notes: string[]): { entries: PipeEntry[]; tier: DataTier } {
    const stack = options.stack ?? [];
    const sources = this.store.listSources();
    const byId = new Map(sources.map((s) => [s.id, s]));
    let everything = false;
    const wanted = new Set<number>();
    const fromPipes: PipeEntry[] = [];
    let tier: DataTier = "public";
    for (const input of doc.inputs) {
      if (input.kind === "all") {
        everything = true;
      } else if (input.kind === "folder") {
        const matches = sources.filter((s) => s.folder === input.name || s.folder.startsWith(`${input.name} / `));
        if (!matches.length) notes.push(`No feed is in the folder "${input.name}".`);
        for (const s of matches) wanted.add(s.id);
      } else if (input.kind === "feed") {
        if (byId.has(input.id)) wanted.add(input.id);
        else notes.push("A feed this pipe reads no longer exists.");
      } else {
        const sub = this.store.getPipe(input.id);
        if (!sub) {
          notes.push("A pipe this pipe reads no longer exists.");
          continue;
        }
        if (stack.includes(input.id)) throw new Error(`The pipe "${sub.name}" ends up reading itself`);
        if (stack.length >= MAX_DEPTH) {
          notes.push(`Pipes read other pipes only ${MAX_DEPTH} levels deep, so "${sub.name}" was left out.`);
          continue;
        }
        const result = this.evaluate(sub.doc, { ...options, stack: [...stack, input.id] });
        if (result.tier === "private") tier = "private";
        notes.push(...result.notes);
        fromPipes.push(...result.entries);
      }
    }
    const readable = everything ? sources : sources.filter((s) => wanted.has(s.id));
    if (readable.some((s) => s.tier === "private")) tier = "private";
    const items = everything ? this.store.listItems({ view: "inbox", limit: GATHER_LIMIT, wide: true }) : this.store.listItems({ view: "inbox", limit: GATHER_LIMIT, wide: true, sourceIds: [...wanted] });
    const seen = new Set<number>();
    const entries: PipeEntry[] = [];
    for (const item of items) {
      const s = byId.get(item.sourceId);
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      entries.push(toEntry(item, s?.folder ?? "", s?.tier ?? "public"));
    }
    for (const e of fromPipes) {
      if (seen.has(e.itemId)) continue;
      seen.add(e.itemId);
      entries.push({ ...e, tags: [...e.tags] });
    }
    entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.itemId - a.itemId));
    return { entries, tier };
  }

  private apply(step: PipeStep, entries: PipeEntry[], options: RunOptions, notes: string[]): { entries: PipeEntry[]; waiting: number } {
    switch (step.op) {
      case "filter": {
        const test = (e: PipeEntry): boolean => (step.match === "all" ? step.conditions.every((c) => conditionHolds(c, e)) : step.conditions.some((c) => conditionHolds(c, e)));
        return { entries: entries.filter((e) => test(e) === step.keep), waiting: 0 };
      }
      case "newer-than": {
        const cutoff = new Date(Date.now() - step.days * 86_400_000).toISOString();
        return { entries: entries.filter((e) => e.at >= cutoff), waiting: 0 };
      }
      case "dedupe": {
        const seen = new Set<string>();
        const kept = entries.filter((e) => {
          const key = step.by === "url" ? e.url.replace(/#.*$/, "") : normalizeTitle(e.title);
          if (!key) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return { entries: kept, waiting: 0 };
      }
      case "sort": {
        const sign = step.order === "asc" ? 1 : -1;
        const key = (e: PipeEntry): string => (step.by === "date" ? e.at : step.by === "title" ? e.title.toLowerCase() : e.source.toLowerCase());
        return { entries: [...entries].sort((a, b) => (key(a) < key(b) ? -sign : key(a) > key(b) ? sign : 0)), waiting: 0 };
      }
      case "limit": {
        if (!step.perSource) return { entries: entries.slice(0, step.count), waiting: 0 };
        const counts = new Map<number, number>();
        return {
          entries: entries.filter((e) => {
            const n = (counts.get(e.sourceId) ?? 0) + 1;
            counts.set(e.sourceId, n);
            return n <= step.count;
          }),
          waiting: 0,
        };
      }
      case "rewrite": {
        const re = step.regex ? compile(step.find, "gi") : compile(escapeRegex(step.find), "gi");
        if (!re) return { entries, waiting: 0 };
        let rejected = 0;
        const out = entries.map((e) => {
          const before = step.field === "title" ? e.title : step.field === "text" ? e.text : step.field === "url" ? e.url : e.author;
          const after = step.regex ? before.replace(re, step.replace) : before.replace(re, () => step.replace);
          if (after === before) return e;
          if (step.field === "url" && !/^https?:\/\//i.test(after)) {
            rejected++;
            return e;
          }
          return { ...e, [step.field]: after } as PipeEntry;
        });
        if (rejected) notes.push("A rewrite would have made a link that does not start with http or https, so those links were left as they were.");
        return { entries: out, waiting: 0 };
      }
      case "tag":
        return { entries: entries.map((e) => (e.tags.includes(step.tag) ? e : { ...e, tags: [...e.tags, step.tag] })), waiting: 0 };
      case "summary":
        return { entries: entries.map((e) => (e.summary ? { ...e, text: e.summary } : e)), waiting: 0 };
      case "ask": {
        const key = askKey(step.question);
        const answers = this.store.pipeAnswers(key, entries.map((e) => e.itemId));
        const kept: PipeEntry[] = [];
        const waiting: PipeEntry[] = [];
        for (const e of entries) {
          const a = answers.get(e.itemId);
          if (!a) waiting.push(e);
          else if (a.answer === (step.keep === "yes")) kept.push(e);
        }
        if (waiting.length) {
          if (options.pending) {
            const slot = options.pending.get(key) ?? { key, question: step.question, entries: [] };
            slot.entries.push(...waiting.filter((w) => !slot.entries.some((s) => s.itemId === w.itemId)));
            options.pending.set(key, slot);
          }
          notes.push(this.judge ? `${waiting.length} items are waiting for the AI to answer "${snippet(step.question, 60)}".` : `The AI question "${snippet(step.question, 60)}" waits until a model is available.`);
        }
        return { entries: kept, waiting: waiting.length };
      }
    }
  }

  /** private when the pipe reads any private feed, directly or through other pipes. Worked out without running the pipe. */
  tierOf(doc: PipeDoc, seen = new Set<number>()): DataTier {
    const sources = this.store.listSources();
    for (const input of doc.inputs) {
      if (input.kind === "all" && sources.some((s) => s.tier === "private")) return "private";
      if (input.kind === "folder" && sources.some((s) => s.tier === "private" && (s.folder === input.name || s.folder.startsWith(`${input.name} / `)))) return "private";
      if (input.kind === "feed" && sources.some((s) => s.id === input.id && s.tier === "private")) return "private";
      if (input.kind === "pipe" && !seen.has(input.id)) {
        seen.add(input.id);
        const sub = this.store.getPipe(input.id);
        if (sub && this.tierOf(sub.doc, seen) === "private") return "private";
      }
    }
    return "public";
  }

  /** The pipes (by id) that read this one directly. */
  usedBy(id: number): number[] {
    return this.store
      .listPipes()
      .filter((p) => p.doc.inputs.some((i) => i.kind === "pipe" && i.id === id))
      .map((p) => p.id);
  }

  /** True when saving this document as pipe `id` would make it read itself, however indirectly. */
  wouldLoop(id: number | null, doc: PipeDoc): boolean {
    if (id === null) return false;
    const seen = new Set<number>();
    const stack = doc.inputs.flatMap((i) => (i.kind === "pipe" ? [i.id] : []));
    while (stack.length) {
      const next = stack.pop() as number;
      if (next === id) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      const pipe = this.store.getPipe(next);
      if (pipe) for (const input of pipe.doc.inputs) if (input.kind === "pipe") stack.push(input.id);
    }
    return false;
  }

  /** Background pass: asks the AI the questions pipes are waiting on, a bounded number per call. */
  async runAsks(priority: Priority, maxQuestions = 20): Promise<{ answered: number; failed: number; queued: number }> {
    const out = { answered: 0, failed: 0, queued: 0 };
    if (!this.judge) return out;
    const pending = new Map<string, PendingAsk>();
    for (const pipe of this.store.listPipes()) {
      if (!pipe.doc.steps.some((s) => s.op === "ask")) continue;
      try {
        this.evaluate(pipe.doc, { stack: [pipe.id], pending });
      } catch {
        // A pipe that reads itself has nothing to ask; the API refuses to save one.
      }
    }
    const todo = [...pending.values()].flatMap((p) => p.entries.map((e) => ({ ask: p, entry: e })));
    let asked = 0;
    for (const { ask, entry } of todo) {
      if (asked >= maxQuestions) {
        out.queued = todo.length - asked;
        break;
      }
      asked++;
      try {
        const verdict = await this.judge.yesNo({ question: ask.question, facts: { title: entry.title, text: snippet(entry.summary || entry.text, 600), source: entry.source } }, { tier: entry.tier, priority, lane: "pipe_ask" });
        this.store.savePipeAnswer(ask.key, entry.itemId, { answer: verdict.answer, probability: verdict.probability, model: verdict.model });
        out.answered++;
      } catch (error) {
        if (error instanceof NoEndpointError) {
          out.queued = todo.length - asked + 1;
          return out;
        }
        out.failed++;
      }
    }
    return out;
  }
}
