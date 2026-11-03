import { dot, kmeans, mean } from "./vectors.ts";
import { cluster, SAME_TOPIC_SIMILARITY } from "../proposals/proposer.ts";
import type { Store } from "../store/store.ts";

export function tasteTopics(store: Store, model: string | null): { itemIds: number[]; liked: number; disliked: number; titles: string[]; lastVotedAt: string }[] {
  if (!model) return [];
  const votes = store.topicVotes(model);
  const byId = new Map(votes.map((v) => [v.id, v]));
  return cluster(votes, SAME_TOPIC_SIMILARITY)
    .map((itemIds) => {
      const members = itemIds.map((id) => byId.get(id)!);
      if (members.length === 1 && !members[0]!.reason.trim()) return null;
      const liked = members.filter((v) => v.vote > 0).length;
      const lastVotedAt = members.reduce((last, v) => v.votedAt > last ? v.votedAt : last, "");
      const titles = members.sort((a, b) => b.itemAt.localeCompare(a.itemAt) || b.id - a.id).slice(0, 3).map((v) => v.title);
      return { itemIds, liked, disliked: members.length - liked, titles, lastVotedAt };
    })
    .filter((topic) => topic !== null)
    .sort((a, b) => b.itemIds.length - a.itemIds.length || b.lastVotedAt.localeCompare(a.lastVotedAt))
    .slice(0, 50)
    .sort((a, b) => b.lastVotedAt.localeCompare(a.lastVotedAt));
}

/** Affinity of an item to a set of liked examples: 0.6 nearest of up to three prototypes plus 0.4 mean of the top three neighbours. */
export class Affinity {
  readonly size: number;
  private readonly examples: Float32Array[];
  private readonly prototypes: Float32Array[];

  constructor(examples: Float32Array[]) {
    this.examples = examples;
    this.size = examples.length;
    this.prototypes = kmeans(examples, 3);
  }

  score(x: Float32Array): number {
    if (!this.size) return 0;
    let nearest = -Infinity;
    for (const p of this.prototypes) nearest = Math.max(nearest, dot(x, p));
    const top = this.examples
      .map((e) => dot(x, e))
      .sort((a, b) => b - a)
      .slice(0, 3);
    return 0.6 * nearest + 0.4 * (top.reduce((a, b) => a + b, 0) / top.length);
  }
}

/** The single-centroid baseline kept for comparison in the harness. */
export function centroidScore(examples: Float32Array[]): (x: Float32Array) => number {
  const center = mean(examples);
  return (x) => dot(x, center);
}

export interface TasteScore {
  /** Positive affinity minus a damped negative affinity; unitless and only comparable within one embedding model. */
  score: number;
  positive: number;
  negative: number;
  /** False until there is at least one liked example, so a cold start never ranks or hides anything. */
  ready: boolean;
}

const MIN_NEGATIVES = 3;
const NEGATIVE_WEIGHT = 0.5;

/** Learned taste: liked examples first, disliked examples only once enough votes exist. Low affinity may demote but never hides on its own. */
export class TasteModel {
  readonly liked: Affinity;
  readonly disliked: Affinity | null;

  constructor(liked: Float32Array[], disliked: Float32Array[] = []) {
    this.liked = new Affinity(liked);
    this.disliked = disliked.length >= MIN_NEGATIVES ? new Affinity(disliked) : null;
  }

  score(x: Float32Array): TasteScore {
    if (!this.liked.size) return { score: 0, positive: 0, negative: 0, ready: false };
    const positive = this.liked.score(x);
    const negative = this.disliked ? this.disliked.score(x) : 0;
    return { score: positive - NEGATIVE_WEIGHT * negative, positive, negative, ready: true };
  }
}

/** Lower bound of the Wilson score interval, used to promote a learned rule only on evidence. */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denominator);
}
