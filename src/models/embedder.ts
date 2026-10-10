import type { DataTier } from "../store/store.ts";
import { normalize } from "../taste/vectors.ts";
import { NoEndpointError } from "./pool.ts";
import { ModelMismatchError } from "./provider.ts";
import type { ModelProvider, Priority } from "./provider.ts";

export interface EmbedderOptions {
  provider: ModelProvider;
  /** Task prefix some models expect (nomic: "clustering: "). */
  documentPrefix?: string;
  queryPrefix?: string;
  /** Truncate to this many dimensions, then renormalize. */
  dims?: number;
  batchSize?: number;
}

export interface Embedded {
  vectors: Float32Array[];
  /** The tag stored beside every vector. Vectors from different tags are never compared. */
  tag: string;
}

/** Embeds text through a ModelProvider and tags each vector with the model that served it. */
export class Embedder {
  private readonly options: EmbedderOptions;

  constructor(options: EmbedderOptions) {
    this.options = options;
  }

  get batchSize(): number {
    return this.options.batchSize ?? 16;
  }

  /** The tag the next vectors will carry, or null while the provider cannot say. */
  async tag(): Promise<string | null> {
    const model = await this.options.provider.embeddingModel();
    if (!model) return null;
    return this.options.dims ? `${model}@${this.options.dims}` : model;
  }

  private async embed(tier: DataTier, priority: Priority, texts: string[], prefix: string): Promise<Embedded> {
    const { provider, dims } = this.options;
    const expected = await provider.embeddingModel();
    if (!expected) throw new NoEndpointError("No embedding model is available yet");
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize).map((t) => prefix + t);
      const result = await provider.embed({ tier, priority, texts: chunk });
      if (result.model !== expected) throw new ModelMismatchError(expected, result.model);
      for (const v of result.vectors) out.push(normalize(v, dims));
    }
    return { vectors: out, tag: dims ? `${expected}@${dims}` : expected };
  }

  documents(tier: DataTier, priority: Priority, texts: string[]): Promise<Embedded> {
    return this.embed(tier, priority, texts, this.options.documentPrefix ?? "");
  }

  /** Rule sentences and examples are the user's own text, not feed data, so they travel as the public tier. */
  queries(priority: Priority, texts: string[]): Promise<Embedded> {
    return this.embed("public", priority, texts, this.options.queryPrefix ?? this.options.documentPrefix ?? "");
  }
}

/** Text embedded for an item: the title, then the author and a trimmed body, so a headline-only entry still carries signal. */
export function itemEmbeddingText(item: { title: string; author: string; text: string }): string {
  const parts = [item.title];
  if (item.author) parts.push(`by ${item.author}`);
  if (item.text) parts.push(item.text.slice(0, 1200));
  return parts.join("\n");
}
