// The Watch module's first slice: sign in to Trakt, keep a local copy of the up-next list, and attach where each show can be watched.
// Trakt is the record of what has been watched; this copy is only for showing it fast and is dropped on disconnect.
import { randomBytes } from "node:crypto";
import type { Store, WatchUpNextRow } from "../store/store.ts";
import { OUT_OF_BAND, pkcePair, TraktAuthError, TraktClient, TraktHttpError } from "./trakt.ts";
import type { TraktUpNext } from "./trakt.ts";
import { providerNames, TmdbClient, whereToWatch } from "./tmdb.ts";
import type { ProviderMap, WhereToWatch } from "./tmdb.ts";

/** Availability is looked up again after this long. TMDB's terms allow a cached copy for six months at most. */
const PROVIDER_REFRESH_MS = 3 * 86_400_000;
const REGION_LIST_REFRESH_MS = 7 * 86_400_000;
/** Cached availability older than this is deleted, well inside the six-month limit. */
const PROVIDER_KEEP_MS = 150 * 86_400_000;
const PROVIDERS_PER_SYNC = 25;
const PENDING_MS = 900_000;
const MAX_PENDING = 5;
const MAX_SERVICES = 60;

export const TMDB_NOTICE = "This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";
export const JUSTWATCH_CREDIT = "Streaming availability data is provided by JustWatch, through TMDB.";

export interface WatchStatus {
  traktConfigured: boolean;
  tmdbConfigured: boolean;
  connected: boolean;
  username: string;
  vip: boolean;
  lastSyncAt: string | null;
  lastError: string;
  region: string;
  services: string[];
  providerChoices: string[];
  /** True when sign-in ends on a Trakt page that shows a code to paste in, rather than coming back on its own. */
  manualCode: boolean;
  attribution: string[];
}

export interface UpNextView {
  showId: number;
  title: string;
  year: number | null;
  traktUrl: string;
  poster: string;
  aired: number;
  completed: number;
  next: { season: number; number: number; title: string; firstAired: string | null; runtime: number | null } | null;
  /** "upcoming" counts down to msUntil; "aired" is ready to watch; "unknown" has no air date. */
  availability: { state: "aired" | "upcoming" | "unknown"; msUntil: number };
  where: WhereToWatch | null;
}

export interface WatchOptions {
  store: Store;
  trakt: TraktClient;
  tmdb: TmdbClient | null;
  /** Where Trakt sends the person back after they approve; the out-of-band address when the server has no web address of its own. */
  redirectUri?: string | undefined;
  clock?: () => Date;
  random?: (size: number) => Buffer;
}

interface Pending {
  verifier: string;
  redirectUri: string;
  startedAt: number;
}

export class WatchService {
  private readonly store: Store;
  private readonly trakt: TraktClient;
  private readonly tmdb: TmdbClient | null;
  private readonly redirectUri: string;
  private readonly clock: () => Date;
  private readonly random: (size: number) => Buffer;
  private readonly pending = new Map<string, Pending>();
  private syncing: Promise<{ shows: number; providers: number }> | null = null;

  constructor(options: WatchOptions) {
    this.store = options.store;
    this.trakt = options.trakt;
    this.tmdb = options.tmdb;
    this.redirectUri = options.redirectUri || OUT_OF_BAND;
    this.clock = options.clock ?? (() => new Date());
    this.random = options.random ?? randomBytes;
  }

  async status(): Promise<WatchStatus> {
    const region = this.region();
    const services = this.services();
    const seen = providerNames(this.store.allProviderPayloads("tv").map((p) => safeParse(p)), region);
    return {
      traktConfigured: this.trakt.configured(),
      tmdbConfigured: Boolean(this.tmdb?.configured()),
      connected: await this.trakt.connected(),
      username: this.store.getMeta("watch:username") ?? "",
      vip: this.store.getMeta("watch:vip") === "1",
      lastSyncAt: this.store.getMeta("watch:lastSync") ?? null,
      lastError: this.store.getMeta("watch:lastError") ?? "",
      region,
      services,
      providerChoices: [...new Set([...seen, ...this.regionList(region), ...services])].sort((a, b) => a.localeCompare(b)),
      manualCode: this.redirectUri === OUT_OF_BAND,
      attribution: this.tmdb?.configured() ? [TMDB_NOTICE, JUSTWATCH_CREDIT] : [],
    };
  }

  /** Starts a sign-in: the address to send the person to, and the state that ties their answer back to it. */
  start(): { url: string; state: string; manualCode: boolean } {
    const now = this.clock().getTime();
    for (const [state, p] of this.pending) if (now - p.startedAt > PENDING_MS) this.pending.delete(state);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    const { verifier, challenge } = pkcePair(this.random);
    const state = this.random(16).toString("hex");
    this.pending.set(state, { verifier, redirectUri: this.redirectUri, startedAt: now });
    return { url: this.trakt.authorizeUrl(this.redirectUri, state, challenge), state, manualCode: this.redirectUri === OUT_OF_BAND };
  }

  /** Finishes a sign-in with the code Trakt gave and the state from start(). A state works once. */
  async finish(code: string, state: string): Promise<void> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    try {
      if (!pending || this.clock().getTime() - pending.startedAt > PENDING_MS) throw new TraktAuthError("That sign-in has expired. Start it again.");
      await this.trakt.exchange(code.trim(), pending.verifier, pending.redirectUri);
    } catch (error) {
      this.store.setMeta("watch:lastError", describe(error));
      throw error;
    }
    this.store.setMeta("watch:lastError", "");
  }

  /** Signs out of Trakt and drops the local copy of the person's list. */
  async disconnect(): Promise<void> {
    await this.trakt.disconnect();
    this.store.clearWatchData();
    for (const key of ["watch:username", "watch:vip", "watch:lastSync", "watch:lastError"]) this.store.setMeta(key, "");
  }

  /** Refreshes the up-next list from Trakt and tops up the cached availability. Calls made while a sync runs share it. */
  sync(): Promise<{ shows: number; providers: number }> {
    this.syncing ??= this.runSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async runSync(): Promise<{ shows: number; providers: number }> {
    try {
      const account = await this.trakt.account();
      this.store.setMeta("watch:username", account.username);
      this.store.setMeta("watch:vip", account.vip ? "1" : "0");
      const items = await this.trakt.upNext();
      this.store.replaceUpNext(items.map(toRow), this.clock());
      this.store.setMeta("watch:lastSync", this.clock().toISOString());
      this.store.setMeta("watch:lastError", "");
      const providers = await this.refreshProviders();
      return { shows: items.length, providers };
    } catch (error) {
      this.store.setMeta("watch:lastError", describe(error));
      throw error;
    }
  }

  /** Looks up availability for shows that have none cached or a stale copy, a few at a time. A failing lookup is skipped; the show keeps whatever it had. */
  private async refreshProviders(): Promise<number> {
    const tmdb = this.tmdb;
    this.store.purgeProviderCache(new Date(this.clock().getTime() - PROVIDER_KEEP_MS));
    if (!tmdb?.configured()) return 0;
    const now = this.clock().getTime();
    const due = this.store
      .listUpNext()
      .flatMap((r) => (r.tmdbId === null ? [] : [r.tmdbId]))
      .filter((id) => {
        const cached = this.store.getProviderCache("tv", id);
        return !cached || now - Date.parse(cached.fetchedAt) > PROVIDER_REFRESH_MS;
      })
      .slice(0, PROVIDERS_PER_SYNC);
    await this.refreshRegionList(tmdb);
    let fetched = 0;
    for (const id of due) {
      try {
        const map = await tmdb.watchProviders("tv", id);
        this.store.saveProviderCache("tv", id, JSON.stringify(map), this.clock());
        fetched++;
      } catch (error) {
        console.warn(`Watch: availability for TMDB title ${id} could not be fetched: ${describe(error)}`);
        if (error instanceof Error && /refused the read token/.test(error.message)) break;
      }
    }
    return fetched;
  }

  /** The services TMDB lists for the chosen country, kept for a week, so the list a person ticks from is not limited to what their shows use. */
  private async refreshRegionList(tmdb: TmdbClient): Promise<void> {
    const region = this.region();
    const saved = this.savedRegionList();
    if (saved && saved.region === region && this.clock().getTime() - Date.parse(saved.fetchedAt) <= REGION_LIST_REFRESH_MS) return;
    try {
      const names = await tmdb.regionProviders("tv", region);
      this.store.setMeta("watch:regionList", JSON.stringify({ region, fetchedAt: this.clock().toISOString(), names }));
    } catch (error) {
      console.warn(`Watch: the list of services for ${region} could not be fetched: ${describe(error)}`);
    }
  }

  private savedRegionList(): { region: string; fetchedAt: string; names: string[] } | null {
    const saved = safeParse(this.store.getMeta("watch:regionList") ?? "") as { region?: unknown; fetchedAt?: unknown; names?: unknown } | null;
    if (!saved || typeof saved.region !== "string" || typeof saved.fetchedAt !== "string" || !Array.isArray(saved.names)) return null;
    return { region: saved.region, fetchedAt: saved.fetchedAt, names: saved.names.filter((n): n is string => typeof n === "string") };
  }

  private regionList(region: string): string[] {
    const saved = this.savedRegionList();
    return saved && saved.region === region ? saved.names : [];
  }

  upNext(): UpNextView[] {
    const now = this.clock().getTime();
    const region = this.region();
    const services = this.services();
    return this.store.listUpNext().map((r) => {
      const cached = r.tmdbId === null ? undefined : this.store.getProviderCache("tv", r.tmdbId);
      const map: ProviderMap | null = cached ? (safeParse(cached.payload) as ProviderMap) : null;
      const firstAired = r.nextFirstAired ? Date.parse(r.nextFirstAired) : NaN;
      return {
        showId: r.showId,
        title: r.title,
        year: r.year,
        traktUrl: `https://trakt.tv/shows/${encodeURIComponent(r.slug)}`,
        poster: r.poster,
        aired: r.aired,
        completed: r.completed,
        next: r.nextSeason === null || r.nextNumber === null ? null : { season: r.nextSeason, number: r.nextNumber, title: r.nextTitle, firstAired: r.nextFirstAired, runtime: r.nextRuntime },
        availability: Number.isNaN(firstAired) ? { state: "unknown", msUntil: 0 } : firstAired > now ? { state: "upcoming", msUntil: firstAired - now } : { state: "aired", msUntil: 0 },
        where: map ? whereToWatch(map, region, services) : null,
      };
    });
  }

  region(): string {
    const saved = this.store.getMeta("watch:region");
    return saved && /^[A-Z]{2}$/.test(saved) ? saved : "US";
  }

  services(): string[] {
    const parsed = safeParse(this.store.getMeta("watch:services") ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  }

  saveSettings(input: { region?: unknown; services?: unknown }): void {
    if (input.region !== undefined) {
      if (typeof input.region !== "string" || !/^[A-Za-z]{2}$/.test(input.region)) throw new RangeError("The region must be a two-letter country code");
      this.store.setMeta("watch:region", input.region.toUpperCase());
    }
    if (input.services !== undefined) {
      if (!Array.isArray(input.services) || input.services.some((s) => typeof s !== "string")) throw new RangeError("Services must be a list of names");
      const names = [...new Set((input.services as string[]).map((s) => s.trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_SERVICES);
      this.store.setMeta("watch:services", JSON.stringify(names));
    }
  }
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** A short line for the screen: no response bodies, no tokens. */
function describe(error: unknown): string {
  if (error instanceof TraktHttpError || error instanceof TraktAuthError) return error.message;
  return error instanceof Error ? error.message.slice(0, 200) : "The sync failed";
}

/** Trakt's image addresses come without a scheme; only Trakt's own hosts are kept. */
function posterUrl(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return url.protocol === "https:" && (url.hostname === "trakt.tv" || url.hostname.endsWith(".trakt.tv")) ? url.toString() : "";
  } catch {
    return "";
  }
}

function toRow(item: TraktUpNext): WatchUpNextRow {
  const { show, progress } = item;
  const next = progress.next_episode;
  return {
    showId: show.ids.trakt,
    title: show.title,
    year: show.year ?? null,
    slug: show.ids.slug ?? String(show.ids.trakt),
    tmdbId: show.ids.tmdb ?? null,
    imdbId: show.ids.imdb ?? null,
    tvdbId: show.ids.tvdb ?? null,
    poster: posterUrl(show.images?.poster?.[0]),
    status: show.status ?? "",
    network: show.network ?? "",
    aired: progress.aired,
    completed: progress.completed,
    lastWatchedAt: progress.last_watched_at ?? null,
    nextSeason: next?.season ?? null,
    nextNumber: next?.number ?? null,
    nextTitle: next?.title ?? "",
    nextFirstAired: next?.first_aired ?? null,
    nextRuntime: next?.runtime ?? null,
  };
}
