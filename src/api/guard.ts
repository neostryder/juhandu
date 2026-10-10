// The browser guard for the JSON API. The server has no sign-in, so a web page open in the owner's browser must not be able to use it:
// the Host header has to be one of this machine's own names or a name listed in JUHANDU_PUBLIC_HOST (against DNS rebinding),
// and any Origin has to be one of those names too (against a page on another site sending requests).
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]", "::1"];

function hostOf(value: string): string {
  const match = value.trim().toLowerCase().match(/^(\[[0-9a-f:]+\]|[^:]+)(?::\d+)?$/);
  return match?.[1] ?? "";
}

export interface GuardHeaders {
  host?: string | undefined;
  origin?: string | undefined;
}

export class RequestGuard {
  private readonly allowed: Set<string>;

  constructor(publicHosts: string[] = []) {
    this.allowed = new Set([...LOOPBACK, ...publicHosts.map((h) => hostOf(h)).filter(Boolean)]);
  }

  /** Returns why the request is refused, or null when it may go on. */
  refusal(headers: GuardHeaders): string | null {
    if (!this.allowed.has(hostOf(headers.host ?? ""))) return "This server does not answer requests addressed to that host name. Set JUHANDU_PUBLIC_HOST to the name you use.";
    if (headers.origin !== undefined) {
      let origin = "";
      try {
        origin = new URL(headers.origin).hostname;
      } catch {
        return "The request came from an origin that is not allowed";
      }
      if (!this.allowed.has(origin === "::1" ? "[::1]" : origin)) return "The request came from an origin that is not allowed";
    }
    return null;
  }
}
