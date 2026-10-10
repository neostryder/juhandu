// Who may use the MCP door and what they may do. The settings live in the meta table; the optional access token lives in the SecretStore
// and is shown once when it is made. Without a token the door answers only requests that look like they come from this machine.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/store.ts";
import type { McpSettings } from "./server.ts";

const TOKEN_SECRET = "mcp.token";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

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

export class McpAccess {
  private readonly store: Store;
  private readonly secrets: SecretStore | undefined;
  private readonly allowedHosts: Set<string>;

  constructor(options: { store: Store; secrets?: SecretStore; allowedHosts?: string[] }) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.allowedHosts = new Set([...LOOPBACK, ...(options.allowedHosts ?? []).map((h) => h.toLowerCase())]);
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
   * True when a request may use the door. With a token set, the Authorization header must carry it. With none, the Host header must be one of
   * this machine's own names (against DNS rebinding) and any Origin must be on this machine too (against a web page in a browser).
   */
  async allows(headers: { authorization?: string | undefined; host?: string | undefined; origin?: string | undefined }): Promise<boolean> {
    const token = this.secrets ? await this.secrets.get(TOKEN_SECRET) : undefined;
    if (token) {
      const given = /^Bearer (.+)$/i.exec(headers.authorization ?? "")?.[1] ?? "";
      return timingSafeEqual(digest(given), digest(token));
    }
    if (!this.allowedHosts.has(hostOf(headers.host ?? ""))) return false;
    if (headers.origin !== undefined) {
      try {
        if (!LOOPBACK.has(new URL(headers.origin).hostname)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
}
