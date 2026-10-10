// Feed logins. Four kinds are supported: a private link with the token in the URL, HTTP basic login, one extra header, or a pasted session cookie.
// The secret part lives only in the SecretStore under source/<id>. The database keeps the kind, and for a private link a masked URL.
import { randomBytes } from "node:crypto";
import type { Source } from "../store/store.ts";
import type { SecretStore } from "../secrets/store.ts";

export type LoginKind = "url" | "basic" | "header" | "cookie";

export type Login =
  | { kind: "url"; url: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "header"; name: string; value: string }
  | { kind: "cookie"; cookie: string };

/** Headers a login must not set: they would break the request or let a feed redirect traffic. */
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "expect", "proxy-authorization", "proxy-connection", "keep-alive"]);
const MAX_FIELD = 4000;

function text(value: unknown, label: string, max = MAX_FIELD): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} is too long`);
  if (/[\r\n\0]/.test(value)) throw new Error(`${label} cannot contain a line break`);
  return value;
}

/** Validates the login part of an API request. Throws an Error with a message that never repeats the secret. */
export function parseLogin(raw: unknown): Login {
  if (!raw || typeof raw !== "object") throw new Error("The login must be an object");
  const body = raw as Record<string, unknown>;
  switch (body["kind"]) {
    case "url": {
      const url = text(body["url"], "The private link", 2000);
      if (!/^https?:\/\//i.test(url)) throw new Error("The private link must start with http:// or https://");
      return { kind: "url", url };
    }
    case "basic":
      return { kind: "basic", username: text(body["username"], "The user name", 300), password: text(body["password"], "The password", 300) };
    case "header": {
      const name = text(body["name"], "The header name", 100);
      if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error("A header name has only letters, digits and hyphens");
      if (FORBIDDEN_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === "cookie") throw new Error("That header cannot be set here");
      return { kind: "header", name, value: text(body["value"], "The header value") };
    }
    case "cookie":
      return { kind: "cookie", cookie: text(body["cookie"], "The cookie") };
    default:
      throw new Error("The login kind must be url, basic, header or cookie");
  }
}

/** The extra request headers a login adds. A private link adds none: the token is already in the URL. */
export function loginHeaders(login: Login): Record<string, string> {
  switch (login.kind) {
    case "basic":
      return { authorization: `Basic ${Buffer.from(`${login.username}:${login.password}`, "utf8").toString("base64")}` };
    case "header":
      return { [login.name.toLowerCase()]: login.value };
    case "cookie":
      return { cookie: login.cookie };
    default:
      return {};
  }
}

/** What the database holds for a private link: the host to show, and a random marker so two private links on one host stay distinct. */
export function maskUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}/***#secret-${randomBytes(5).toString("hex")}`;
}

/** The part of a masked URL that is safe to show. */
export function displayUrl(url: string): string {
  const at = url.indexOf("#secret-");
  return at >= 0 ? url.slice(0, at) : url;
}

export const secretNameFor = (sourceId: number): string => `source/${sourceId}`;

export interface Access {
  url: string;
  headers: Record<string, string>;
}

/** Looks logins up in the SecretStore on behalf of the poller and the API. */
export class Credentials {
  private readonly secrets: SecretStore;

  constructor(secrets: SecretStore) {
    this.secrets = secrets;
  }

  /** Tracks the parts of a login that must never appear in an error message or a log line. */
  private track(login: Login): Login {
    if (login.kind === "url") this.secrets.track(login.url);
    else if (login.kind === "basic") this.secrets.track(login.password);
    else if (login.kind === "header") this.secrets.track(login.value);
    else this.secrets.track(login.cookie);
    return login;
  }

  /** Text with every login value taken out, safe to store or show. */
  redact(text: string): string {
    return this.secrets.redact(text);
  }

  async save(sourceId: number, login: Login): Promise<string> {
    this.track(login);
    return this.secrets.setJson(secretNameFor(sourceId), login);
  }

  async remove(sourceId: number): Promise<void> {
    await this.secrets.delete(secretNameFor(sourceId));
  }

  async load(sourceId: number): Promise<Login | undefined> {
    const login = await this.secrets.getJson<Login>(secretNameFor(sourceId));
    return login ? this.track(login) : undefined;
  }

  /** The URL to fetch and the headers to send for a source. A source with no login gets its stored URL and no extras. */
  async access(source: Pick<Source, "id" | "url" | "auth">): Promise<Access> {
    if (!source.auth) return { url: source.url, headers: {} };
    const login = await this.load(source.id);
    if (!login || login.kind !== source.auth) throw new Error("The login for this feed is missing. Replace it to start fetching again.");
    return { url: login.kind === "url" ? login.url : source.url, headers: loginHeaders(login) };
  }

  /** The private-link source that already holds this exact URL, if any. */
  async findByLink(sources: Source[], url: string): Promise<Source | undefined> {
    for (const source of sources) {
      if (source.auth !== "url") continue;
      const login = await this.load(source.id);
      if (login?.kind === "url" && login.url === url) return source;
    }
    return undefined;
  }
}
