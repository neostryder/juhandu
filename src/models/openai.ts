import type { FetchLike } from "../sources/fetcher.ts";
import { BusyError, ClientError } from "./pool.ts";
import type { EndpointInfo } from "./egress.ts";
import type { ChatRequest, ChatResult, TokenProbability } from "./provider.ts";

export interface OpenAIEndpoint extends EndpointInfo {
  /** Base URL up to and including /v1, for example http://127.0.0.1:8080/v1. */
  baseUrl: string;
  /** Model id sent in the request body. */
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Extra fields merged into every chat request, for servers that take non-standard options (for example chat_template_kwargs on llama-server). */
  extraBody?: Record<string, unknown>;
}

export function authHeaders(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) h["authorization"] = `Bearer ${apiKey}`;
  return h;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Maps a failed response to the error the pool and the pipeline understand; returns when the response is usable. */
export function assertUsable(name: string, response: Response): void {
  if (response.status === 429 || response.status === 503) throw new BusyError(`${name} answered ${response.status}`);
  if (response.status >= 500) throw new Error(`${name} answered ${response.status}`);
  if (response.status >= 400) throw new ClientError(response.status, `${name} rejected the request (${response.status})`);
}

async function post(endpoint: OpenAIEndpoint, path: string, body: unknown, fetchImpl: FetchLike): Promise<Response> {
  const response = await fetchImpl(joinUrl(endpoint.baseUrl, path), {
    method: "POST",
    headers: authHeaders(endpoint.apiKey),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(endpoint.timeoutMs ?? 60_000),
  });
  assertUsable(endpoint.name, response);
  return response;
}

export function parseEmbeddings(name: string, data: { data?: { index?: number; embedding?: number[] }[] }, expected: number): Float32Array[] {
  const rows = data.data;
  if (!Array.isArray(rows) || rows.length !== expected) throw new Error(`${name} returned ${rows?.length ?? 0} embeddings for ${expected} inputs`);
  const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return ordered.map((row) => {
    if (!Array.isArray(row.embedding) || !row.embedding.length) throw new Error(`${name} returned an empty embedding`);
    return Float32Array.from(row.embedding);
  });
}

/** One call to an OpenAI-style /embeddings route; returns vectors in input order. */
export async function embedWith(endpoint: OpenAIEndpoint, texts: string[], fetchImpl: FetchLike = fetch): Promise<Float32Array[]> {
  const response = await post(endpoint, "/embeddings", { model: endpoint.model, input: texts }, fetchImpl);
  return parseEmbeddings(endpoint.name, (await response.json()) as { data?: { index?: number; embedding?: number[] }[] }, texts.length);
}

/** The JSON body for an OpenAI-style chat completion, shared by every adapter. */
export function chatBody(model: string, request: ChatRequest, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages: request.messages, stream: false };
  if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;
  body["temperature"] = request.temperature ?? 0.2;
  if (request.json) body["response_format"] = { type: "json_schema", json_schema: { name: request.json.name, strict: true, schema: request.json.schema } };
  if (request.firstTokenLogprobs) {
    body["logprobs"] = true;
    body["top_logprobs"] = request.firstTokenLogprobs;
  }
  return { ...body, ...extra };
}

interface ChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null }; logprobs?: { content?: { top_logprobs?: TokenProbability[] }[] } | null }[];
}

export function parseChat(name: string, data: ChatResponse, servedModel: string | null): ChatResult {
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== "string") throw new Error(`${name} returned no message`);
  const first = choice?.logprobs?.content?.[0]?.top_logprobs;
  return { text, model: servedModel ?? data.model ?? "unknown", ...(first && first.length ? { firstToken: first.map((t) => ({ token: t.token, logprob: t.logprob })) } : {}) };
}

export async function chatWith(endpoint: OpenAIEndpoint, request: ChatRequest, fetchImpl: FetchLike = fetch): Promise<ChatResult> {
  const response = await post(endpoint, "/chat/completions", chatBody(endpoint.model, request, endpoint.extraBody), fetchImpl);
  return parseChat(endpoint.name, (await response.json()) as ChatResponse, null);
}
