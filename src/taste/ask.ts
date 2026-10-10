import type { Embedder } from "../models/embedder.ts";
import { NoEndpointError } from "../models/pool.ts";
import type { Store } from "../store/store.ts";
import { TasteModel } from "./taste.ts";

export interface AskSettings {
  enabled: boolean;
  perDay: number;
}

export const DEFAULT_ASK: AskSettings = { enabled: true, perDay: 3 };
const WINDOW_DAYS = 14;
const MAX_SKIPPED = 500;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The active-learning ask: now and then, one shown item the taste score is least sure about, so one vote teaches the model the most. It never asks more than a few times a day, can be skipped, and can be switched off. */
export class LearningAsk {
  private readonly store: Store;
  private readonly embedder: Embedder | null;
  private readonly clock: () => Date;

  constructor(store: Store, embedder: Embedder | null, clock: () => Date = () => new Date()) {
    this.store = store;
    this.embedder = embedder;
    this.clock = clock;
  }

  settings(): AskSettings {
    const perDay = Number(this.store.getMeta("ask:perDay") ?? DEFAULT_ASK.perDay);
    return { enabled: (this.store.getMeta("ask:enabled") ?? "1") === "1", perDay: Number.isInteger(perDay) && perDay >= 0 && perDay <= 20 ? perDay : DEFAULT_ASK.perDay };
  }

  setSettings(change: Partial<AskSettings>): AskSettings {
    if (change.enabled !== undefined) this.store.setMeta("ask:enabled", change.enabled ? "1" : "0");
    if (change.perDay !== undefined && Number.isInteger(change.perDay) && change.perDay >= 0 && change.perDay <= 20) this.store.setMeta("ask:perDay", String(change.perDay));
    return this.settings();
  }

  private skipped(): number[] {
    try {
      return JSON.parse(this.store.getMeta("ask:skipped") ?? "[]") as number[];
    } catch {
      return [];
    }
  }

  skip(itemId: number): void {
    this.store.setMeta("ask:skipped", JSON.stringify([...this.skipped().filter((id) => id !== itemId), itemId].slice(-MAX_SKIPPED)));
    if (this.store.getMeta("ask:current") === String(itemId)) this.store.setMeta("ask:current", "");
  }

  /** The item to ask about now, or null: asking is off, today's allowance is used, the model is not ready, or nothing is unsure enough to be worth a question. */
  async next(): Promise<number | null> {
    const settings = this.settings();
    if (!settings.enabled || !this.embedder) return null;
    const current = Number(this.store.getMeta("ask:current") || 0);
    if (current && !this.skipped().includes(current) && this.store.listItems({ itemId: current, view: "all", limit: 1 }).some((i) => i.vote === 0)) return current;

    const today = localDay(this.clock());
    if (this.store.getMeta("ask:day") !== today) {
      this.store.setMeta("ask:day", today);
      this.store.setMeta("ask:count", "0");
    }
    if (Number(this.store.getMeta("ask:count") ?? 0) >= settings.perDay) return null;

    let tag: string | null;
    try {
      tag = await this.embedder.tag();
    } catch (error) {
      if (error instanceof NoEndpointError) return null;
      throw error;
    }
    if (!tag) return null;
    const { liked, disliked } = this.store.votedVectors(tag);
    if (liked.length < 2) return null;
    const model = new TasteModel(liked, disliked);
    const since = new Date(this.clock().getTime() - WINDOW_DAYS * 86_400_000).toISOString();
    const skipped = new Set(this.skipped());
    const pool = this.store.askCandidates(tag, since).filter((c) => !skipped.has(c.id));
    if (pool.length < 5) return null;
    const scored = pool.map((c) => ({ id: c.id, score: model.score(c.vec).score }));
    const likedScore = median(liked.map((v) => model.score(v).score));
    const otherScore = disliked.length >= 3 ? median(disliked.map((v) => model.score(v).score)) : [...scored].map((s) => s.score).sort((a, b) => a - b)[Math.floor(scored.length * 0.25)] as number;
    const boundary = (likedScore + otherScore) / 2;
    const pick = scored.reduce((best, s) => (Math.abs(s.score - boundary) < Math.abs(best.score - boundary) ? s : best));
    this.store.setMeta("ask:current", String(pick.id));
    this.store.setMeta("ask:count", String(Number(this.store.getMeta("ask:count") ?? 0) + 1));
    return pick.id;
  }
}
