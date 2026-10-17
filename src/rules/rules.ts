import { auditPass } from "../taste/meter.ts";

/** The rules engine: hard blocks always hide and win, soft weights add or subtract score, pins override soft weights only. */

export type RuleKind = "block" | "weight" | "pin";
export type RuleStatus = "active" | "shadow" | "disabled";
export type RuleOrigin = "user" | "learned";
export type RuleField = "title" | "text" | "author" | "url";

export type RuleScope = { type: "all" } | { type: "folder"; folder: string } | { type: "source"; sourceId: number };

export interface KeywordCondition {
  type: "keyword";
  terms: string[];
  /** "any" matches when one term appears; "all" needs every term. */
  mode: "any" | "all";
  fields: RuleField[];
}

export interface RegexCondition {
  type: "regex";
  pattern: string;
  flags: string;
  fields: RuleField[];
}

export interface SemanticCondition {
  type: "semantic";
  sentence: string;
  examples: string[];
  counterExamples: string[];
  /** Cosine similarity at or above which the rule matches; visible and movable in the UI. */
  threshold: number;
}

/** Matches items whose own link points at one of the domains or any of their subdomains (a domain blocklist). */
export interface DomainCondition {
  type: "domain";
  domains: string[];
}

/** Matches a video that is shorter or longer than a length. An item that is not a known video never matches, and a video whose length is not known yet waits. */
export interface DurationCondition {
  type: "duration";
  op: "under" | "over";
  seconds: number;
}

export const MAX_DURATION_SECONDS = 7 * 86_400;

export type RuleCondition = KeywordCondition | RegexCondition | SemanticCondition | DomainCondition | DurationCondition;

export interface Rule {
  id: number;
  kind: RuleKind;
  scope: RuleScope;
  condition: RuleCondition;
  /** Signed strength for soft weights (-1 to 1); ignored for blocks and pins. */
  weight: number;
  status: RuleStatus;
  origin: RuleOrigin;
  note: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Set when a learned rule passed its shadow bar (or the user promoted it by hand); a promoted learned rule lets a small stable share of its matches through as an audit. */
  promotedAt?: string | null;
}

export interface RuleItem {
  /** The item id, when known; the audit pass-through for a promoted rule needs it. */
  id?: number;
  sourceId: number;
  /** The item's own link; a domain rule reads its host. */
  url: string;
  folder: string;
  title: string;
  text: string;
  author: string;
  /** The video's length in seconds. Left out when the item is not a video whose length can be known; null while the length has not been looked up yet. */
  videoSeconds?: number | null;
}

export interface RuleHit {
  ruleId: number;
  kind: RuleKind;
  /** The score contribution for a weight; 0 for blocks and pins. */
  effect: number;
  /** True for a shadow rule: recorded so its meter can count, never applied. */
  shadow: boolean;
  detail: string;
  /** True when a promoted rule matched but let the item through as its audit sample. */
  audit?: boolean;
}

export type Verdict = "show" | "hide";
export type HideReason = "block" | "soft" | null;

export interface Decision {
  verdict: Verdict;
  hideReason: HideReason;
  pinned: boolean;
  /** Sum of applied soft weights. */
  score: number;
  hits: RuleHit[];
  /** True when a semantic rule could not be evaluated because no embedding exists yet; the item must be re-evaluated, never dropped. */
  incomplete: boolean;
}

/** Returns the similarity of the item to a semantic condition, or null when the item has no embedding yet. */
export type SemanticEvaluator = (condition: SemanticCondition, item: RuleItem) => number | null;

/** A pinned-score total at or below this hides the item softly; the Filtered-out view shows it with the cause. */
export const SOFT_HIDE_AT = -1;

export function ruleApplies(scope: RuleScope, item: RuleItem): boolean {
  if (scope.type === "all") return true;
  if (scope.type === "folder") return item.folder === scope.folder;
  return item.sourceId === scope.sourceId;
}

function fieldText(item: RuleItem, fields: RuleField[]): string {
  return fields.map((f) => item[f]).join("\n");
}

const domainSets = new WeakMap<DomainCondition, Set<string>>();

/** The host of a link, lowercased and without a trailing dot; empty when the link is not an absolute http(s) URL. */
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname.toLowerCase().replace(/\.$/, "") : "";
  } catch {
    return "";
  }
}

/** The listed domain the host belongs to (the host itself or a parent of it), or null. */
export function matchDomain(condition: DomainCondition, host: string): string | null {
  if (!host) return null;
  let set = domainSets.get(condition);
  if (!set) {
    set = new Set(condition.domains.map((d) => d.trim().toLowerCase()).filter(Boolean));
    domainSets.set(condition, set);
  }
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (set.has(candidate)) return candidate;
  }
  return null;
}

const regexCache = new Map<string, RegExp | null>();

function compileRegex(pattern: string, flags: string): RegExp | null {
  const key = `${flags}/${pattern}`;
  if (regexCache.has(key)) return regexCache.get(key) ?? null;
  let compiled: RegExp | null = null;
  try {
    compiled = new RegExp(pattern, flags.replace(/[gy]/g, ""));
  } catch {
    compiled = null;
  }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(key, compiled);
  return compiled;
}

/** Validates a condition and returns a readable problem, or null when it is sound. */
export function validateCondition(condition: RuleCondition): string | null {
  if (condition.type === "keyword") {
    if (!condition.terms.some((t) => t.trim())) return "A keyword rule needs at least one term";
    if (!condition.fields.length) return "Choose at least one field to search";
    return null;
  }
  if (condition.type === "domain") {
    if (!condition.domains.length) return "A domain rule needs at least one domain";
    if (condition.domains.length > 20_000) return "A domain rule can hold at most 20,000 domains";
    return condition.domains.every((d) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) ? null : "Every domain must look like example.com";
  }
  if (condition.type === "duration") {
    if (condition.op !== "under" && condition.op !== "over") return "A video length rule is either under or over a length";
    return Number.isInteger(condition.seconds) && condition.seconds >= 1 && condition.seconds <= MAX_DURATION_SECONDS ? null : "The length must be a whole number of seconds, from 1 second to 7 days";
  }
  if (condition.type === "regex") {
    if (!condition.pattern) return "A regex rule needs a pattern";
    if (condition.pattern.length > 500) return "That pattern is too long";
    if (!condition.fields.length) return "Choose at least one field to search";
    return compileRegex(condition.pattern, condition.flags) ? null : "That pattern is not a valid regular expression";
  }
  if (!condition.sentence.trim() && !condition.examples.length) return "A semantic rule needs a sentence or an example";
  if (!(condition.threshold >= 0 && condition.threshold <= 1)) return "The threshold must be between 0 and 1";
  return null;
}

/** Evaluates one condition. Returns the detail text when it matches, null when it does not, and "pending" when a semantic rule has no embedding to use. */
function matchCondition(condition: RuleCondition, item: RuleItem, semantic: SemanticEvaluator | undefined): string | null | "pending" {
  if (condition.type === "keyword") {
    const haystack = fieldText(item, condition.fields).toLowerCase();
    const terms = condition.terms.map((t) => t.trim().toLowerCase()).filter(Boolean);
    const found = terms.filter((t) => haystack.includes(t));
    const ok = condition.mode === "all" ? terms.length > 0 && found.length === terms.length : found.length > 0;
    return ok ? `keyword: ${found.join(", ")}` : null;
  }
  if (condition.type === "duration") {
    if (item.videoSeconds === undefined) return null;
    if (item.videoSeconds === null) return "pending";
    const hit = condition.op === "under" ? item.videoSeconds < condition.seconds : item.videoSeconds > condition.seconds;
    return hit ? `duration: ${item.videoSeconds}s ${condition.op === "under" ? "<" : ">"} ${condition.seconds}s` : null;
  }
  if (condition.type === "domain") {
    const hit = matchDomain(condition, hostOf(item.url));
    return hit ? `domain: ${hit}` : null;
  }
  if (condition.type === "regex") {
    const re = compileRegex(condition.pattern, condition.flags);
    if (!re) return null;
    const match = re.exec(fieldText(item, condition.fields).slice(0, 20_000));
    return match ? `regex: ${match[0].slice(0, 60)}` : null;
  }
  if (!semantic) return "pending";
  const similarity = semantic(condition, item);
  if (similarity === null) return "pending";
  return similarity >= condition.threshold ? `semantic: ${similarity.toFixed(2)} >= ${condition.threshold.toFixed(2)}` : null;
}

export function evaluateRules(rules: Rule[], item: RuleItem, semantic?: SemanticEvaluator): Decision {
  const hits: RuleHit[] = [];
  let blocked = false;
  let pinned = false;
  let score = 0;
  let incomplete = false;

  for (const rule of rules) {
    if (rule.status === "disabled" || !ruleApplies(rule.scope, item)) continue;
    const result = matchCondition(rule.condition, item, semantic);
    if (result === "pending") {
      incomplete = true;
      continue;
    }
    if (result === null) continue;
    const audit = rule.status === "active" && rule.origin === "learned" && !!rule.promotedAt && item.id !== undefined && auditPass(rule.id, item.id);
    const shadow = rule.status === "shadow" || audit;
    const effect = rule.kind === "weight" ? Math.max(-1, Math.min(1, rule.weight)) : 0;
    hits.push({ ruleId: rule.id, kind: rule.kind, effect, shadow, detail: result, ...(audit ? { audit: true } : {}) });
    if (shadow) continue;
    if (rule.kind === "block") blocked = true;
    else if (rule.kind === "pin") pinned = true;
    else score += effect;
  }

  if (blocked) return { verdict: "hide", hideReason: "block", pinned, score, hits, incomplete };
  if (!pinned && score <= SOFT_HIDE_AT) return { verdict: "hide", hideReason: "soft", pinned, score, hits, incomplete };
  return { verdict: "show", hideReason: null, pinned, score, hits, incomplete };
}
