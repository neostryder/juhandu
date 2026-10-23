import type { FetchLike } from "../sources/fetcher.ts";
import { chatWith, embedWith } from "./openai.ts";
import type { OpenAIEndpoint } from "./openai.ts";
import type { EndpointPool } from "./pool.ts";
import { ModelMismatchError } from "./provider.ts";
import type { Capabilities, ChatRequest, ChatResult, EmbedRequest, EmbedResult, ModelProvider, ProviderStatus } from "./provider.ts";

export interface GenericOptions {
  /** Ordered endpoints for embeddings; each carries its model id. */
  embedPool?: EndpointPool<OpenAIEndpoint>;
  /** Ordered endpoints for chat and judging. */
  chatPool?: EndpointPool<OpenAIEndpoint>;
  /** The tag stored beside vectors, for example embeddinggemma-2. */
  embedTag?: string;
  fetchImpl?: FetchLike;
}

/** Any OpenAI-style service: a hosted API, llama-server, LM Studio, or a bring-your-own endpoint. Priority has no meaning here, because a plain endpoint has no notion of it. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = "openai-compatible";
  readonly capabilities: Capabilities;
  private readonly options: GenericOptions;

  constructor(options: GenericOptions) {
    this.options = options;
    this.capabilities = { embed: Boolean(options.embedPool), chat: Boolean(options.chatPool), decide: false, transcribe: false };
  }

  async embeddingModel(): Promise<string | null> {
    return this.options.embedPool ? (this.options.embedTag ?? this.options.embedPool.list()[0]?.model ?? null) : null;
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const pool = this.options.embedPool;
    if (!pool) throw new Error("No embedding endpoint is configured");
    const vectors = await pool.run(request.tier, (endpoint) => embedWith(endpoint, request.texts, this.options.fetchImpl));
    const model = (await this.embeddingModel()) as string;
    if (vectors.length !== request.texts.length) throw new ModelMismatchError(model, "unknown");
    return { vectors, model };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const pool = this.options.chatPool;
    if (!pool) throw new Error("No chat endpoint is configured");
    return pool.run(request.tier, async (endpoint) => ({ ...(await chatWith(endpoint, request, this.options.fetchImpl)), model: endpoint.model }));
  }

  async status(): Promise<ProviderStatus> {
    const all = [...(this.options.embedPool?.status() ?? []), ...(this.options.chatPool?.status() ?? [])];
    const down = all.filter((e) => e.skippedForMs > 0).length;
    return { name: this.name, ok: down < all.length || all.length === 0, detail: `${all.length} endpoint(s), ${down} skipped`, serves: [...(this.options.embedPool ? ["embed"] : []), ...(this.options.chatPool ? ["chat"] : [])] };
  }
}
