// The Cogitator adapter. It depends on nothing else in the app except the provider interface and two small helpers.
import { readFile } from "node:fs/promises";
import type { FetchLike } from "../sources/fetcher.ts";
import { assertUsable, authHeaders, chatBody, joinUrl, parseChat, parseEmbeddings } from "./openai.ts";
import { ClientError, NoEndpointError } from "./pool.ts";
import { DeferredError, ModelMismatchError } from "./provider.ts";
import type { Capabilities, ChatRequest, ChatResult, EmbedRequest, EmbedResult, Job, ModelProvider, Priority, ProviderStatus } from "./provider.ts";

/** The schema 1 document Cogitator writes at <data_dir>/discovery.json and serves at /v1/cogitator/discovery. */
export interface Discovery {
  schema: number;
  openai_base: string;
  health: string;
  roles: { name: string; chain: string[] }[];
  models: { id: string }[];
}

export interface KeySource {
  /** Reads the key when needed; the value is never logged or stored. */
  get(): Promise<string>;
}

export function keyFromFile(path: string): KeySource {
  return { get: async () => (await readFile(path, "utf-8")).trim() };
}

export function keyFromValue(value: string): KeySource {
  return { get: async () => value };
}

export interface CogitatorOptions {
  /** Path of discovery.json, or a base URL of the gateway when there is no file (then /v1/cogitator/discovery is read). */
  discoveryFile?: string;
  gatewayUrl?: string;
  /** A Low-class key: used for background work, never evicts anything. */
  backgroundKey: KeySource;
  /** A Normal-class key: used for work the user is waiting on. */
  interactiveKey: KeySource;
  /** Job to role name; defaults to the same names, with summarize and judge falling back to "describe". */
  roles?: Partial<Record<Job, string>>;
  fetchImpl?: FetchLike;
  /** How long an interactive call keeps retrying a deferral before giving up. */
  interactiveWaitMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

const DISCOVERY_TTL_MS = 60_000;
const DEFAULT_RETRY_MS = 5_000;

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_MS;
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    return body.error?.code ?? "";
  } catch {
    return "";
  }
}

/** A gateway describes itself as 127.0.0.1, which is right on its own machine and wrong from any other; a client that reached it elsewhere keeps the address it used. */
function reachableBase(doc: Discovery, gatewayUrl: string): Discovery {
  if (doc.schema !== 1 || typeof doc.openai_base !== "string") return doc;
  try {
    const advertised = new URL(doc.openai_base);
    const reached = new URL(gatewayUrl);
    const loopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]";
    if (loopback(advertised.hostname) && !loopback(reached.hostname)) {
      return { ...doc, openai_base: `${reached.origin}${advertised.pathname}${advertised.search}` };
    }
  } catch {
    // A base that does not parse is left for the request to fail on, with its own message.
  }
  return doc;
}

/** A chain entry or served-model header can name the machine that answered ("model@bilbo"). The same model on another machine gives the same vectors, so only the model counts. */
function baseModel(model: string): string {
  return model.replace(/@[\w.-]+$/, "");
}

export class CogitatorProvider implements ModelProvider {
  readonly name = "cogitator";
  readonly capabilities: Capabilities = { embed: true, chat: true, decide: false, transcribe: false };
  private readonly options: CogitatorOptions;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  private discovery: { at: number; doc: Discovery } | null = null;

  constructor(options: CogitatorOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.clock = options.clock ?? Date.now;
  }

  private async loadDiscovery(): Promise<Discovery> {
    if (this.discovery && this.clock() - this.discovery.at < DISCOVERY_TTL_MS) return this.discovery.doc;
    let doc: Discovery | null = null;
    if (this.options.discoveryFile) {
      try {
        doc = JSON.parse(await readFile(this.options.discoveryFile, "utf-8")) as Discovery;
      } catch {
        doc = null;
      }
    }
    if (!doc && this.options.gatewayUrl) {
      try {
        const response = await this.fetchImpl(joinUrl(this.options.gatewayUrl, "/v1/cogitator/discovery"), { headers: authHeaders(await this.options.interactiveKey.get()), signal: AbortSignal.timeout(3_000) });
        if (response.ok) doc = reachableBase((await response.json()) as Discovery, this.options.gatewayUrl);
      } catch {
        doc = null;
      }
    }
    if (!doc || doc.schema !== 1) {
      if (this.discovery) return this.discovery.doc;
      throw new NoEndpointError("Cogitator discovery is not available");
    }
    this.discovery = { at: this.clock(), doc };
    return doc;
  }

  /** The role that serves a job: the configured name, else the same name, else the fallback (summarize and judge use "describe"). */
  private roleFor(doc: Discovery, job: Job): string {
    const names = new Set(doc.roles.map((r) => r.name));
    const wanted = this.options.roles?.[job] ?? job;
    if (names.has(wanted)) return wanted;
    if (job === "embed" && names.has("embed")) return "embed";
    if ((job === "summarize" || job === "judge") && names.has("describe")) return "describe";
    throw new NoEndpointError(`Cogitator has no role for ${job}`);
  }

  async embeddingModel(): Promise<string | null> {
    try {
      const doc = await this.loadDiscovery();
      const role = this.roleFor(doc, "embed");
      const first = doc.roles.find((r) => r.name === role)?.chain[0];
      return first ? baseModel(first) : null;
    } catch (error) {
      if (error instanceof NoEndpointError) return null;
      throw error;
    }
  }

  private key(priority: Priority): Promise<string> {
    return (priority === "background" ? this.options.backgroundKey : this.options.interactiveKey).get();
  }

  /** Sends one request. A deferral on an interactive call is retried until the wait runs out; on a background call it surfaces at once, because the work stays queued and the next cycle retries it. */
  private async send(doc: Discovery, path: string, body: Record<string, unknown>, priority: Priority): Promise<{ response: Response; model: string | null }> {
    const deadline = this.clock() + (priority === "interactive" ? (this.options.interactiveWaitMs ?? 30_000) : 0);
    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(joinUrl(doc.openai_base, path), {
          method: "POST",
          headers: authHeaders(await this.key(priority)),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
        });
      } catch (error) {
        throw new NoEndpointError(`Cogitator is unreachable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 503) {
        const wait = retryAfterMs(response);
        const code = await errorCode(response);
        const label = code === "deferred" ? "Cogitator deferred the request" : "Cogitator is busy";
        if (this.clock() + wait > deadline) throw new DeferredError(label, wait);
        await this.sleep(wait);
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new ClientError(response.status, "Cogitator rejected the key");
      try {
        assertUsable("cogitator", response);
      } catch (error) {
        if (error instanceof ClientError) throw error;
        throw new NoEndpointError(error instanceof Error ? error.message : "Cogitator failed");
      }
      return { response, model: response.headers.get("x-cogitator-model") };
    }
  }

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const doc = await this.loadDiscovery();
    const role = this.roleFor(doc, "embed");
    const expected = baseModel(doc.roles.find((r) => r.name === role)?.chain[0] ?? role);
    const { response, model } = await this.send(doc, "/embeddings", { model: role, input: request.texts }, request.priority);
    const served = model ? baseModel(model) : expected;
    if (served !== expected) throw new ModelMismatchError(expected, served);
    const vectors = parseEmbeddings("cogitator", (await response.json()) as { data?: { index?: number; embedding?: number[] }[] }, request.texts.length);
    return { vectors, model: served };
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const doc = await this.loadDiscovery();
    const role = this.roleFor(doc, request.job);
    const { response, model } = await this.send(doc, "/chat/completions", chatBody(role, request, request.thinking === false ? { chat_template_kwargs: { enable_thinking: false } } : {}), request.priority);
    return parseChat("cogitator", (await response.json()) as Parameters<typeof parseChat>[1], model);
  }

  async status(): Promise<ProviderStatus> {
    try {
      const doc = await this.loadDiscovery();
      const response = await this.fetchImpl(doc.health, { signal: AbortSignal.timeout(3_000) });
      return { name: this.name, ok: response.ok, detail: response.ok ? "healthy" : `health answered ${response.status}`, serves: doc.roles.map((r) => r.name) };
    } catch (error) {
      return { name: this.name, ok: false, detail: error instanceof Error ? error.message : "unreachable", serves: [] };
    }
  }
}
