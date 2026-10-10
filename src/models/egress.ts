import type { DataTier } from "../store/store.ts";

export interface EndpointInfo {
  name: string;
  /** Runs on a machine the owner controls (the model host, a local server): always allowed for every tier. */
  local: boolean;
}

export class EgressDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressDenied";
  }
}

/** The single place where a request may leave the process. Public data may go to any configured endpoint; private data only to local ones or to endpoints the owner named for the private tier. */
export class EgressGate {
  private readonly privateAllow: Set<string>;

  constructor(privateAllow: string[] = []) {
    this.privateAllow = new Set(privateAllow);
  }

  allows(tier: DataTier, endpoint: EndpointInfo): boolean {
    if (endpoint.local) return true;
    if (tier === "public") return true;
    return this.privateAllow.has(endpoint.name);
  }

  assert(tier: DataTier, endpoint: EndpointInfo): void {
    if (!this.allows(tier, endpoint)) throw new EgressDenied(`Endpoint ${endpoint.name} is not allowed to receive ${tier} data`);
  }
}
