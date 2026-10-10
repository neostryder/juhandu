import type { DataTier } from "../store/store.ts";
import type { EgressGate, EndpointInfo } from "./egress.ts";

/** The caller's mistake (a 4xx answer): never fails over, because another endpoint would say the same. */
export class ClientError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ClientError";
    this.status = status;
  }
}

/** Every allowed endpoint is down, busy or forbidden; the pipeline queues the work instead of dropping it. */
export class NoEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoEndpointError";
  }
}

const BUSY_SKIP_MS = 5_000;
const DOWN_SKIP_MS = 30_000;

export class BusyError extends Error {
  constructor(message = "Endpoint is busy") {
    super(message);
    this.name = "BusyError";
  }
}

/** An ordered list of endpoints for one job (embeddings, chat, decisions): the first healthy, allowed one serves each request; a refusal is remembered briefly so a sleeping machine costs one short timeout, not one per request. */
export class EndpointPool<T extends EndpointInfo> {
  private readonly endpoints: T[];
  private readonly gate: EgressGate;
  private readonly clock: () => number;
  private readonly skipUntil = new Map<string, number>();

  constructor(endpoints: T[], gate: EgressGate, clock: () => number = Date.now) {
    this.endpoints = endpoints;
    this.gate = gate;
    this.clock = clock;
  }

  list(): T[] {
    return [...this.endpoints];
  }

  status(): { name: string; local: boolean; skippedForMs: number }[] {
    const now = this.clock();
    return this.endpoints.map((e) => ({ name: e.name, local: e.local, skippedForMs: Math.max(0, (this.skipUntil.get(e.name) ?? 0) - now) }));
  }

  async run<R>(tier: DataTier, fn: (endpoint: T) => Promise<R>): Promise<R> {
    const now = this.clock();
    const allowed = this.endpoints.filter((e) => this.gate.allows(tier, e));
    if (!allowed.length) throw new NoEndpointError(`No endpoint may receive ${tier} data`);
    let lastError: unknown = null;
    for (const endpoint of allowed) {
      if ((this.skipUntil.get(endpoint.name) ?? 0) > now) continue;
      try {
        return await fn(endpoint);
      } catch (error) {
        if (error instanceof ClientError) throw error;
        this.skipUntil.set(endpoint.name, this.clock() + (error instanceof BusyError ? BUSY_SKIP_MS : DOWN_SKIP_MS));
        lastError = error;
      }
    }
    const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new NoEndpointError(`No endpoint is available right now${reason}`);
  }
}
