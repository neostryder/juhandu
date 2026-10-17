// Trakt: sign-in with PKCE (the app has a client id and no client secret), token upkeep, and the few reads the Watch screen needs.
// The user's tokens live in the SecretStore under "trakt/tokens"; nothing from a token reaches the database, an API answer, or an error message.
import { createHash, randomBytes } from "node:crypto";
import type { SecretStore } from "../secrets/store.ts";
import type { FetchLike } from "../sources/fetcher.ts";

const API = "https://api.trakt.tv";
const AUTHORIZE = "https://auth.trakt.tv/oauth/authorize";
const USER_AGENT = "Juhandu (https://github.com/neostryder/juhandu)";
const TOKENS = "trakt/tokens";
/** A token is renewed this long before it runs out, so a request never starts with one about to expire. */
const RENEW_EARLY_MS = 300_000;

/** The redirect address for an app with no web address of its own: Trakt shows the code on a page and the person pastes it in. */
export const OUT_OF_BAND = "urn:ietf:wg:oauth:2.0:oob";

export class TraktNotConnected extends Error {}
/** Trakt refused the sign-in or the saved sign-in has run out; connecting again fixes it. */
export class TraktAuthError extends Error {}
export class TraktRateLimited extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`Trakt asked for a pause; try again in ${retryAfterSeconds} seconds`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
export class TraktHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/** The challenge Trakt checks the verifier against: SHA-256 of the verifier, base64url without padding. */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** A fresh random verifier (64 characters from the allowed set) and its challenge. A verifier is used for one sign-in and then dropped. */
export function pkcePair(random: (size: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = base64url(random(48));
  return { verifier, challenge: challengeFor(verifier) };
}

export interface TraktTokens {
  accessToken: string;
  refreshToken: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  redirectUri: string;
}

export interface TraktShow {
  title: string;
  year: number | null;
  ids: { trakt: number; slug?: string; tmdb?: number | null; imdb?: string | null; tvdb?: number | null };
  images?: { poster?: string[] };
  status?: string;
  network?: string | null;
}

export interface TraktEpisode {
  season: number;
  number: number;
  title?: string | null;
  first_aired?: string | null;
  runtime?: number | null;
}

export interface TraktUpNext {
  show: TraktShow;
  progress: { aired: number; completed: number; last_watched_at?: string | null; next_episode: TraktEpisode | null };
}

export interface TraktAccount {
  username: string;
  vip: boolean;
}

export interface TraktOptions {
  /** The app's client id, read each time so a newly saved one is used without a restart. */
  clientId: () => string | undefined;
  secrets: SecretStore;
  fetchImpl?: FetchLike;
  clock?: () => number;
}

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; created_at?: number; error?: string };

export class TraktClient {
  private readonly options: TraktOptions;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => number;
  private refreshing: Promise<TraktTokens> | null = null;

  constructor(options: TraktOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  /** True when the app's client id is known, which is all PKCE sign-in needs. */
  configured(): boolean {
    return Boolean(this.options.clientId());
  }

  async connected(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  authorizeUrl(redirectUri: string, state: string, challenge: string): string {
    const params = new URLSearchParams({ response_type: "code", client_id: this.clientId(), redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256" });
    return `${AUTHORIZE}?${params.toString()}`;
  }

  /** Trades the code Trakt showed or sent back for tokens, proving it started the sign-in with the verifier. */
  async exchange(code: string, verifier: string, redirectUri: string): Promise<void> {
    const reply = await this.tokenCall({ code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code" });
    await this.save(reply, redirectUri);
  }

  async disconnect(): Promise<void> {
    await this.options.secrets.delete(TOKENS);
  }

  /** The signed-in person's name and whether the account is VIP. */
  async account(): Promise<TraktAccount> {
    const { body } = await this.get<{ user?: { username?: string; vip?: boolean } }>("/users/settings");
    return { username: body.user?.username ?? "", vip: Boolean(body.user?.vip) };
  }

  /** Every page of the up-next list, newest activity first, up to a sane cap. */
  async upNext(pageSize = 100, maxPages = 10): Promise<TraktUpNext[]> {
    const out: TraktUpNext[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const { body, headers } = await this.get<TraktUpNext[]>("/sync/progress/up_next", { extended: "full,images", page: String(page), limit: String(pageSize) });
      out.push(...(Array.isArray(body) ? body : []));
      if (page >= Number(headers.get("x-pagination-page-count") ?? 1)) break;
    }
    return out;
  }

  async get<T>(path: string, query: Record<string, string> = {}): Promise<{ body: T; headers: Headers }> {
    const url = `${API}${path}${Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ""}`;
    let token = await this.accessToken();
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, { headers: this.headers({ authorization: `Bearer ${token}` }), signal: AbortSignal.timeout(20_000) });
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel();
        token = await this.accessToken(token);
        continue;
      }
      if (response.status === 401) {
        await response.body?.cancel();
        throw new TraktAuthError("Trakt no longer accepts the saved sign-in. Connect again.");
      }
      if (response.status === 429) {
        await response.body?.cancel();
        throw new TraktRateLimited(Number(response.headers.get("retry-after") ?? 60) || 60);
      }
      if (response.status === 426) {
        await response.body?.cancel();
        throw new TraktHttpError(426, "Trakt answers that this needs a VIP account.");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new TraktHttpError(response.status, `Trakt answered HTTP ${response.status}`);
      }
      return { body: (await response.json()) as T, headers: response.headers };
    }
  }

  private clientId(): string {
    const id = this.options.clientId();
    if (!id) throw new Error("No Trakt client id is set. Set JUHANDU_TRAKT_CLIENT_ID or store the secret trakt/client_id.");
    return id;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { "content-type": "application/json", accept: "application/json", "trakt-api-version": "2", "trakt-api-key": this.clientId(), "user-agent": USER_AGENT, ...extra };
  }

  private async load(): Promise<TraktTokens | null> {
    const raw = await this.options.secrets.get(TOKENS);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<TraktTokens>;
      if (typeof parsed.accessToken === "string" && typeof parsed.refreshToken === "string" && typeof parsed.expiresAt === "number" && typeof parsed.redirectUri === "string") return parsed as TraktTokens;
    } catch {
      // Falls through to "not connected": a damaged record is the same as none.
    }
    return null;
  }

  /** The access token to use. `stale` is the token that just failed: if someone already replaced it, the replacement is used instead of spending the single-use refresh token twice. */
  private async accessToken(stale?: string): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw new TraktNotConnected("Trakt is not connected");
    const usable = tokens.accessToken !== stale && tokens.expiresAt - RENEW_EARLY_MS > this.clock();
    if (usable) return tokens.accessToken;
    this.refreshing ??= this.refresh(tokens).finally(() => {
      this.refreshing = null;
    });
    return (await this.refreshing).accessToken;
  }

  private async refresh(old: TraktTokens): Promise<TraktTokens> {
    let reply: TokenReply;
    try {
      reply = await this.tokenCall({ refresh_token: old.refreshToken, redirect_uri: old.redirectUri, grant_type: "refresh_token" });
    } catch (error) {
      if (error instanceof TraktAuthError) await this.disconnect();
      throw error;
    }
    return this.save(reply, old.redirectUri);
  }

  private async tokenCall(body: Record<string, string>): Promise<TokenReply> {
    const response = await this.fetchImpl(`${API}/oauth/token`, { method: "POST", headers: this.headers(), body: JSON.stringify({ ...body, client_id: this.clientId() }), signal: AbortSignal.timeout(20_000) });
    const reply = (await response.json().catch(() => ({}))) as TokenReply;
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new TraktAuthError(`Trakt did not accept the sign-in (${reply.error ?? `HTTP ${response.status}`}). Connect again.`);
    if (!response.ok) throw new TraktHttpError(response.status, `Trakt answered HTTP ${response.status}`);
    if (!reply.access_token || !reply.refresh_token) throw new TraktHttpError(502, "Trakt sent no tokens");
    return reply;
  }

  private async save(reply: TokenReply, redirectUri: string): Promise<TraktTokens> {
    const tokens: TraktTokens = {
      accessToken: reply.access_token as string,
      refreshToken: reply.refresh_token as string,
      expiresAt: ((reply.created_at ?? Math.floor(this.clock() / 1000)) + (reply.expires_in ?? 7_776_000)) * 1000,
      redirectUri,
    };
    await this.options.secrets.set(TOKENS, JSON.stringify(tokens));
    return tokens;
  }
}
