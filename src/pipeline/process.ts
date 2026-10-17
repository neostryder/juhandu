import { itemEmbeddingText } from "../models/embedder.ts";
import type { Embedder } from "../models/embedder.ts";
import { NoEndpointError } from "../models/pool.ts";
import type { Priority } from "../models/provider.ts";
import { evaluateRules } from "../rules/rules.ts";
import type { Rule, RuleCondition, RuleItem, SemanticCondition } from "../rules/rules.ts";
import { youtubeVideoId } from "../video/ids.ts";
import type { VideoDurations } from "../video/duration.ts";
import type { PendingItem, Store } from "../store/store.ts";
import { TasteModel } from "../taste/taste.ts";
import { dot } from "../taste/vectors.ts";

export interface ProcessResult {
  embedded: number;
  decided: number;
  /** Items that could not be embedded because no endpoint was available; they stay queued. */
  queued: number;
}

export interface PreviewRow {
  itemId: number;
  title: string;
  /** Null for keyword and regex conditions, and for items with no embedding yet. */
  similarity: number | null;
  matched: boolean;
}

interface SemanticVectors {
  positive: Float32Array[];
  negative: Float32Array[];
}

function semanticKey(tag: string, c: SemanticCondition): string {
  return JSON.stringify([tag, c.sentence, c.examples, c.counterExamples]);
}

/** Similarity to the closest example or sentence, unless a counter-example is closer, in which case the rule does not match. */
export function semanticSimilarity(item: Float32Array, vectors: SemanticVectors): number {
  let positive = -1;
  for (const v of vectors.positive) positive = Math.max(positive, dot(item, v));
  let negative = -1;
  for (const v of vectors.negative) negative = Math.max(negative, dot(item, v));
  return negative >= positive ? -1 : positive;
}

/** Cheap-first pipeline: embed new items, evaluate rules, record taste affinity in shadow. Nothing is ever dropped for lack of a model. */
export class Processor {
  private readonly store: Store;
  private readonly embedder: Embedder | null;
  private readonly clock: () => Date;
  private readonly semanticCache = new Map<string, SemanticVectors>();
  private tasteCache: { key: string; model: TasteModel } | null = null;
  private readonly durations: VideoDurations | null;

  constructor(store: Store, embedder: Embedder | null, clock: () => Date = () => new Date(), durations: VideoDurations | null = null) {
    this.store = store;
    this.embedder = embedder;
    this.clock = clock;
    this.durations = durations;
  }

  private usesDurations(rules: Rule[]): boolean {
    return rules.some((r) => r.status !== "disabled" && r.condition.type === "duration");
  }

  /** Looks up the length of the public YouTube videos waiting for a decision, when a duration rule is in use. A private-tier item is never looked up. */
  async resolveDurations(limit = 200): Promise<number> {
    const durations = this.durations;
    if (!durations || !this.usesDurations(this.store.listRules())) return 0;
    const ids = [...new Set(this.store.itemsNeedingDecision(500).flatMap((p) => (p.tier === "public" ? [youtubeVideoId(p.url)] : [])).filter((id): id is string => id !== null))];
    const known = this.store.getVideoDurations(ids);
    const need = ids.filter((id) => !known.has(id)).slice(0, limit);
    if (!need.length) return 0;
    const source = durations.mode();
    const found = await durations.lookup(need);
    for (const [id, seconds] of found) this.store.saveVideoDuration(id, seconds, source, this.clock());
    return found.size;
  }

  /** The length a rule sees for an item: nothing for a non-video, a private-tier item or a video with no length to give; null while the length has not been looked up. */
  private videoSecondsFor(item: PendingItem, known: Map<string, number>): Pick<RuleItem, "videoSeconds"> {
    const id = youtubeVideoId(item.url);
    if (!id || item.tier !== "public") return {};
    const seconds = known.get(id);
    if (seconds === undefined) return this.durations ? { videoSeconds: null } : {};
    return seconds < 0 ? {} : { videoSeconds: seconds };
  }

  private knownDurations(rules: Rule[], items: PendingItem[]): Map<string, number> {
    if (!this.usesDurations(rules)) return new Map();
    return this.store.getVideoDurations(items.flatMap((i) => (i.tier === "public" ? [youtubeVideoId(i.url)] : [])).filter((id): id is string => id !== null));
  }

  /** The tag current vectors carry, or null when embeddings are off or the provider cannot say yet. */
  private async currentTag(): Promise<string | null> {
    try {
      return (await this.embedder?.tag()) ?? null;
    } catch (error) {
      if (error instanceof NoEndpointError) return null;
      throw error;
    }
  }

  async embedPending(priority: Priority = "background", limit = 200): Promise<{ embedded: number; queued: number }> {
    const embedder = this.embedder;
    const tag = await this.currentTag();
    if (!embedder || !tag) return { embedded: 0, queued: embedder ? this.store.itemsNeedingEmbedding("none", limit).length : 0 };
    const pending = this.store.itemsNeedingEmbedding(tag, limit);
    let embedded = 0;
    for (const tier of ["public", "private"] as const) {
      const group = pending.filter((p) => p.tier === tier);
      if (!group.length) continue;
      try {
        const result = await embedder.documents(tier, priority, group.map(itemEmbeddingText));
        group.forEach((item, i) => {
          this.store.saveEmbedding(item.id, result.tag, result.vectors[i] as Float32Array, this.clock());
          embedded++;
        });
      } catch (error) {
        if (!(error instanceof NoEndpointError)) throw error;
      }
    }
    return { embedded, queued: pending.length - embedded };
  }

  /** Embeds the sentence and examples of every active semantic rule once; a failure leaves the rule pending, not matching. */
  private async prepareSemantic(tag: string | null, priority: Priority, conditions: SemanticCondition[]): Promise<void> {
    const embedder = this.embedder;
    if (!embedder || !tag) return;
    for (const c of conditions) {
      const key = semanticKey(tag, c);
      if (this.semanticCache.has(key)) continue;
      const positiveTexts = [c.sentence, ...c.examples].filter((t) => t.trim());
      try {
        const { vectors } = await embedder.queries(priority, [...positiveTexts, ...c.counterExamples]);
        this.semanticCache.set(key, { positive: vectors.slice(0, positiveTexts.length), negative: vectors.slice(positiveTexts.length) });
      } catch (error) {
        if (!(error instanceof NoEndpointError)) throw error;
      }
    }
    if (this.semanticCache.size > 500) this.semanticCache.clear();
  }

  private taste(modelTag: string): TasteModel {
    const { liked, disliked } = this.store.votedVectors(modelTag);
    const key = `${modelTag}:${liked.length}:${disliked.length}`;
    if (this.tasteCache?.key !== key) this.tasteCache = { key, model: new TasteModel(liked, disliked) };
    return this.tasteCache.model;
  }

  async decidePending(priority: Priority = "background", limit = 500): Promise<number> {
    const pending: PendingItem[] = this.store.itemsNeedingDecision(limit);
    if (!pending.length) return 0;
    const rules = this.store.listRules();
    const semanticConditions = rules.flatMap((r) => (r.status !== "disabled" && r.condition.type === "semantic" ? [r.condition] : []));
    const modelTag = await this.currentTag();
    await this.prepareSemantic(modelTag, priority, semanticConditions);
    const taste = modelTag ? this.taste(modelTag) : null;
    const known = this.knownDurations(rules, pending);
    for (const item of pending) {
      const vector = modelTag ? this.store.getEmbedding(item.id, modelTag) : undefined;
      const decision = evaluateRules(rules, { id: item.id, sourceId: item.sourceId, url: item.url, folder: item.folder, title: item.title, text: item.text, author: item.author, ...this.videoSecondsFor(item, known) }, (condition) => {
        const prepared = modelTag ? this.semanticCache.get(semanticKey(modelTag, condition)) : undefined;
        return vector && prepared ? semanticSimilarity(vector, prepared) : null;
      });
      const tasteScore = vector && taste ? taste.score(vector) : null;
      this.store.saveDecision(item.id, { ...decision, taste: tasteScore?.ready ? tasteScore.score : null }, this.clock());
    }
    return pending.length;
  }

  /** Shows how a draft condition would act on the most recent items, strongest match first, so a threshold is chosen by looking, not guessing. */
  async preview(condition: RuleCondition, limit = 200): Promise<PreviewRow[]> {
    const items = this.store.recentItemsForPreview(limit);
    const modelTag = await this.currentTag();
    if (condition.type === "semantic") await this.prepareSemantic(modelTag, "interactive", [condition]);
    const prepared = condition.type === "semantic" && modelTag ? this.semanticCache.get(semanticKey(modelTag, condition)) : undefined;
    const known = condition.type === "duration" ? this.store.getVideoDurations(items.flatMap((i) => (i.tier === "public" ? [youtubeVideoId(i.url)] : [])).filter((id): id is string => id !== null)) : new Map<string, number>();
    const rows: PreviewRow[] = items.map((item) => {
      const ruleItem = { id: item.id, sourceId: item.sourceId, url: item.url, folder: item.folder, title: item.title, text: item.text, author: item.author, ...this.videoSecondsFor(item, known) };
      const vector = modelTag ? this.store.getEmbedding(item.id, modelTag) : undefined;
      let similarity: number | null = null;
      let matched = false;
      if (condition.type === "semantic") {
        similarity = vector && prepared ? semanticSimilarity(vector, prepared) : null;
        matched = similarity !== null && similarity >= condition.threshold;
      } else {
        const decision = evaluateRules([{ id: 0, kind: "block", scope: { type: "all" }, condition, weight: 0, status: "active", origin: "user", note: "", version: 1, createdAt: "", updatedAt: "" }], ruleItem);
        matched = decision.hits.length > 0;
      }
      return { itemId: item.id, title: item.title, similarity, matched };
    });
    return rows.sort((a, b) => (b.similarity ?? -2) - (a.similarity ?? -2) || Number(b.matched) - Number(a.matched));
  }

  async run(): Promise<ProcessResult> {
    const { embedded, queued } = await this.embedPending("background");
    try {
      await this.resolveDurations();
    } catch (error) {
      console.warn(`Video length lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const decided = await this.decidePending("background");
    return { embedded, decided, queued };
  }
}
