import type { Rule } from "../rules/rules.ts";
import type { Store } from "../store/store.ts";

/** The shadow bar: prospective votes only, a minimum count, an observed agreement and a one-sided Wilson lower bound. */
export interface Bar {
  votes: number;
  agreement: number;
  lowerBound: number;
  /** One-sided z for the lower bound (85% is 1.036, 90% is 1.2816). */
  z: number;
}

export const NARROW_BAR: Bar = { votes: 30, agreement: 0.95, lowerBound: 0.85, z: 1.0364 };
export const BROAD_BAR: Bar = { votes: 50, agreement: 0.98, lowerBound: 0.9, z: 1.2816 };

/** A rule that matches at least this share of decided items has a wide blast radius and faces the broad bar. */
export const BROAD_MATCH_RATE = 0.1;

/** Share of a promoted rule's matches that still show, chosen by a fixed hash so a decision does not flicker. */
export const AUDIT_PERCENT = 5;

export function wilsonLower(agree: number, n: number, z: number): number {
  if (n <= 0) return 0;
  const p = agree / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/** The vote that means the rule is right about an item it matched: a hide or demotion is right when the user dislikes it, a favor or pin when the user likes it. */
export function expectedVote(rule: Pick<Rule, "kind" | "weight">): 1 | -1 {
  if (rule.kind === "block") return -1;
  if (rule.kind === "pin") return 1;
  return rule.weight >= 0 ? 1 : -1;
}

export interface RuleMeter {
  /** Votes cast after the rule was accepted, on items it matched. */
  votes: number;
  agree: number;
  rate: number;
  lower: number;
  broad: boolean;
  bar: Bar;
  met: boolean;
}

/** Counts only votes cast after the rule existed, so the rule is never graded on the evidence it was drafted from. */
export function computeMeter(rule: Pick<Rule, "kind" | "weight" | "createdAt">, votes: { vote: number; votedAt: string }[], broad: boolean): RuleMeter {
  const bar = broad ? BROAD_BAR : NARROW_BAR;
  const want = expectedVote(rule);
  const counted = votes.filter((v) => v.votedAt > rule.createdAt);
  const agree = counted.filter((v) => v.vote === want).length;
  const n = counted.length;
  const rate = n ? agree / n : 0;
  const lower = wilsonLower(agree, n, bar.z);
  return { votes: n, agree, rate, lower, broad, bar, met: n >= bar.votes && rate >= bar.agreement && lower >= bar.lowerBound };
}

/** Whether this item is one of the audit pass-through items for a promoted rule: a stable 5 percent of matches. */
export function auditPass(ruleId: number, itemId: number): boolean {
  let h = (ruleId * 2654435761 + itemId * 40503) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) % 100 < AUDIT_PERCENT;
}

/** The meter of every rule that has one: shadow rules (watching) and promoted learned rules. Broad rules (wide reach) face the stricter bar. */
export function ruleMeters(store: Store): Map<number, RuleMeter> {
  const rules = store.listRules().filter((r) => r.status === "shadow" || (r.origin === "learned" && r.promotedAt));
  if (!rules.length) return new Map();
  const votes = store.votesByRule();
  const counts = store.ruleMatchCounts();
  const decided = Math.max(store.decidedCount(), 1);
  const out = new Map<number, RuleMeter>();
  for (const rule of rules) {
    const c = counts.get(rule.id);
    const matched = (c?.acting ?? 0) + (c?.shadow ?? 0);
    out.set(rule.id, computeMeter(rule, votes.get(rule.id) ?? [], matched / decided >= BROAD_MATCH_RATE));
  }
  return out;
}

/** Promotes every shadow learned rule whose meter has met its bar. Returns the rules promoted. */
export function promoteDue(store: Store, now = new Date()): Rule[] {
  const promoted: Rule[] = [];
  for (const [id, meter] of ruleMeters(store)) {
    const rule = store.getRule(id);
    if (!rule || rule.origin !== "learned" || rule.status !== "shadow" || !meter.met) continue;
    const next = store.promoteRule(id, now);
    if (next) promoted.push(next);
  }
  return promoted;
}
