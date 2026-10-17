// Who may use the MCP door and what they may do. The settings live in the meta table; the optional access token lives in the SecretStore
// and is shown once when it is made. Without a token the door answers only requests that come straight from this machine, never through a proxy.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/store.ts";
import type { McpSettings } from "./server.ts";

const TOKEN_SECRET = "mcp.token";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** Headers a reverse proxy or tunnel adds. A request that carries any of them came through one, so it is not from this machine, whatever its Host says. */
export const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "cf-connecting-ip", "cf-connecting-ipv6", "cf-ray", "cf-access-jwt-assertion", "true-client-ip", "x-client-ip", "via"] as const;

export interface McpStatus extends McpSettings {
  tokenSet: boolean;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function hostOf(value: string): string {
  const match = value.trim().toLowerCase().match(/^(\[[0-9a-f:]+\]|[^:]+)(?::\d+)?$/);
  return match?.[1] ?? "";
}

/** The port a Host header names explicitly, or an empty string when it names none. */
function portOf(value: string): string {
  return value.trim().match(/:(\d+)$/)?.[1] ?? "";
}

export class McpAccess {
  private readonly store: Store;
  private readonly secrets: SecretStore | undefined;

  constructor(options: { store: Store; secrets?: SecretStore }) {
    this.store = options.store;
    this.secrets = options.secrets;
  }

  settings(): McpSettings {
    let saved: Partial<McpSettings> = {};
    try {
      saved = JSON.parse(this.store.getMeta("mcp:settings") ?? "{}") as Partial<McpSettings>;
    } catch {
      saved = {};
    }
    return { allowWrites: saved.allowWrites === true, includePrivate: saved.includePrivate === true };
  }

  async status(): Promise<McpStatus> {
    return { ...this.settings(), tokenSet: this.secrets ? Boolean(await this.secrets.get(TOKEN_SECRET)) : false };
  }

  update(patch: Partial<McpSettings>): McpSettings {
    const next = { ...this.settings() };
    if (typeof patch.allowWrites === "boolean") next.allowWrites = patch.allowWrites;
    if (typeof patch.includePrivate === "boolean") next.includePrivate = patch.includePrivate;
    this.store.setMeta("mcp:settings", JSON.stringify(next));
    return next;
  }

  /** Makes a new access token, replacing any old one. The token is returned once and never again. */
  async newToken(): Promise<string> {
    if (!this.secrets) throw new Error("There is no secret store, so a token cannot be kept");
    const token = `jhd_${randomBytes(24).toString("base64url")}`;
    await this.secrets.set(TOKEN_SECRET, token);
    return token;
  }

  async clearToken(): Promise<void> {
    await this.secrets?.delete(TOKEN_SECRET);
  }

  /**
   * True when a request may use the door. With a token set, the Authorization header must carry it. With none, the request must come straight
   * from this machine: the Host header must be one of this machine's own names (against DNS rebinding), no proxy header may be present (a
   * proxy on this machine would otherwise let the whole internet in), and any Origin must be on this machine too (against a web page in a
   * browser). A public name from JUHANDU_PUBLIC_HOST never counts as this machine.
   */
  async allows(headers: { authorization?: string | undefined; host?: string | undefined; origin?: string | undefined; proxied?: boolean }): Promise<boolean> {
    const token = this.secrets ? await this.secrets.get(TOKEN_SECRET) : undefined;
    if (token) {
      const given = /^Bearer (.+)$/i.exec(headers.authorization ?? "")?.[1] ?? "";
      return timingSafeEqual(digest(given), digest(token));
    }
    if (headers.proxied) return false;
    if (!LOOPBACK.has(hostOf(headers.host ?? ""))) return false;
    if (headers.origin !== undefined) {
      try {
        const origin = new URL(headers.origin);
        if (!LOOPBACK.has(origin.hostname)) return false;
        // A page served on another local port is a different origin, so it may not drive the door either.
        const originPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
        const hostPort = portOf(headers.host ?? "");
        if (hostPort ? originPort !== hostPort : originPort !== "80" && originPort !== "443") return false;
      } catch {
        return false;
      }
    }
    return true;
  }
}

/** True when a request carries a header that a reverse proxy or tunnel adds. */
export function cameThroughProxy(headers: Record<string, unknown>): boolean {
  return PROXY_HEADERS.some((name) => headers[name] !== undefined);
}
