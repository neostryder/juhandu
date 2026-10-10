import type { DataTier } from "../store/store.ts";
import { NoEndpointError } from "./pool.ts";

/** background: the embedding backlog, polling-time summaries and learning. interactive: something the user is waiting on (rule preview, on-demand briefing). */
export type Priority = "background" | "interactive";

/** The four jobs Juhandu asks a model host for. */
export type Job = "embed" | "summarize" | "judge" | "transcribe";

export interface CallContext {
  tier: DataTier;
  priority: Priority;
}

export interface EmbedRequest extends CallContext {
  texts: string[];
}

export interface EmbedResult {
  vectors: Float32Array[];
  /** The model that actually produced the vectors, which is what gets stored beside them. */
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest extends CallContext {
  job: "summarize" | "judge";
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Constrain the reply to JSON, optionally to a schema. */
  json?: { name: string; schema: Record<string, unknown> };
  /** Ask for the log-probabilities of the first generated token (used to calibrate a yes/no answer). */
  firstTokenLogprobs?: number;
  /** false asks a reasoning model to answer at once. A calibrated yes/no needs it, because a thinking model's first token is its reasoning marker, not the answer. */
  thinking?: boolean;
}

export interface TokenProbability {
  token: string;
  logprob: number;
}

export interface ChatResult {
  text: string;
  model: string;
  firstToken?: TokenProbability[];
}

export interface ProviderStatus {
  name: string;
  ok: boolean;
  detail: string;
  /** Roles or models this provider says it can serve. */
  serves: string[];
}

export interface Capabilities {
  embed: boolean;
  chat: boolean;
  /** Typed decisions through POST /v1/systemone, the typed-decision protocol spoken by self-hosted servers and the hosted Jev service. */
  decide: boolean;
  transcribe: boolean;
}

/** One seam for every local or hosted model service. The Cogitator adapter is the local one; nothing above this interface may depend on a particular adapter. */
export interface ModelProvider {
  readonly name: string;
  readonly capabilities: Capabilities;
  /** The tag the next embeddings will carry, or null while the provider cannot say (nothing is embedded until it can). */
  embeddingModel(): Promise<string | null>;
  embed(request: EmbedRequest): Promise<EmbedResult>;
  chat(request: ChatRequest): Promise<ChatResult>;
  status(): Promise<ProviderStatus>;
}

/** The host deferred the work because serving it would push something else out of memory; the work stays queued and is retried. */
export class DeferredError extends NoEndpointError {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "DeferredError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** A different embedding model answered than the one the vectors are tagged for; storing them would mix incompatible spaces, so the work is queued. */
export class ModelMismatchError extends NoEndpointError {
  constructor(expected: string, served: string) {
    super(`Embedding model ${served} answered, but vectors are tagged ${expected}`);
    this.name = "ModelMismatchError";
  }
}
