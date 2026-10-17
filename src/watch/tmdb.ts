// TMDB watch-provider lookups. The data comes from TMDB's partnership with JustWatch: it is shown with credit to both,
// cached for days (TMDB's terms allow at most six months), and kept out of every AI call.
import type { FetchLike } from "../sources/fetcher.ts";

const API = "https://api.themoviedb.org/3";
const USER_AGENT = "Juhandu (https://github.com/neostryder/juhandu)";

export type OfferKind = "flatrate" | "free" | "ads" | "rent" | "buy";
export const OFFER_KINDS: OfferKind[] = ["flatrate", "free", "ads", "rent", "buy"];
/** The kinds that mean watching without paying per title. */
export const STREAM_KINDS: OfferKind[] = ["flatrate", "free", "ads"];

export interface ProviderOffer {
  id: number;
  name: string;
}

export interface CountryOffers {
  link: string;
  flatrate: ProviderOffer[];
  free: ProviderOffer[];
  ads: ProviderOffer[];
  rent: ProviderOffer[];
  buy: ProviderOffer[];
}

/** Offers by two-letter country code. */
export type ProviderMap = Record<string, CountryOffers>;

type RawOffer = { provider_id?: number; provider_name?: string };
type RawCountry = { link?: string } & Partial<Record<OfferKind, RawOffer[]>>;

export interface TmdbOptions {
  /** The v4 read access token, read each time so a newly saved one is used without a restart. */
  token: () => string | undefined;
  fetchImpl?: FetchLike;
}

export class TmdbClient {
  private readonly options: TmdbOptions;
  private readonly fetchImpl: FetchLike;

  constructor(options: TmdbOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  configured(): boolean {
    return Boolean(this.options.token());
  }

  /** Where a show or movie can be watched, by country. A title TMDB has no entry for answers an empty map. */
  async watchProviders(kind: "tv" | "movie", tmdbId: number): Promise<ProviderMap> {
    const body = await this.get(`/${kind}/${tmdbId}/watch/providers`);
    return body === null ? {} : parseProviders(body);
  }

  /** Every streaming service TMDB lists for a country, so a person can tick one that none of their shows uses yet. */
  async regionProviders(kind: "tv" | "movie", region: string): Promise<string[]> {
    const body = await this.get(`/watch/providers/${kind}?watch_region=${encodeURIComponent(region)}`);
    return body === null ? [] : parseProviderList(body);
  }

  /** One authorized GET. A 404 answers null; any other failure throws. */
  private async get(path: string): Promise<unknown> {
    const token = this.options.token();
    if (!token) throw new Error("No TMDB read token is set. Set JUHANDU_TMDB_READ_TOKEN or store the secret tmdb/token.");
    const response = await this.fetchImpl(`${API}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status === 401) {
      await response.body?.cancel();
      throw new Error("TMDB refused the read token");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`TMDB answered HTTP ${response.status}`);
    }
    return response.json();
  }
}

function offers(raw: RawOffer[] | undefined): ProviderOffer[] {
  return (raw ?? []).flatMap((o) => (typeof o.provider_id === "number" && typeof o.provider_name === "string" ? [{ id: o.provider_id, name: o.provider_name }] : []));
}

/** The countries and offers in a TMDB answer, kept to the fields shown. */
export function parseProviders(body: unknown): ProviderMap {
  const results = (body as { results?: Record<string, RawCountry> } | null)?.results ?? {};
  const out: ProviderMap = {};
  for (const [country, raw] of Object.entries(results)) {
    if (!/^[A-Z]{2}$/.test(country) || !raw || typeof raw !== "object") continue;
    const entry: CountryOffers = { link: typeof raw.link === "string" && raw.link.startsWith("https://") ? raw.link : "", flatrate: offers(raw.flatrate), free: offers(raw.free), ads: offers(raw.ads), rent: offers(raw.rent), buy: offers(raw.buy) };
    if (OFFER_KINDS.some((k) => entry[k].length)) out[country] = entry;
  }
  return out;
}

/** The provider names in TMDB's list of services for a country, sorted. */
export function parseProviderList(body: unknown): string[] {
  const results = (body as { results?: { provider_name?: unknown }[] } | null)?.results;
  const names = new Set<string>();
  for (const r of Array.isArray(results) ? results : []) if (typeof r?.provider_name === "string" && r.provider_name.trim()) names.add(r.provider_name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

export interface WhereToWatch {
  /** Offers in the chosen country from the services the person has. */
  mine: { name: string; kind: OfferKind }[];
  /** Every other offer in the chosen country. */
  home: { name: string; kind: OfferKind }[];
  /** Other countries that stream it, with the person's own services listed first. */
  elsewhere: { country: string; providers: string[]; mine: string[] }[];
  /** TMDB's page for the title in the chosen country, which lists the offers with their links. */
  link: string;
}

const norm = (name: string): string => name.trim().toLowerCase();

/** Sorts a title's offers into the three groups the Watch screen shows. */
export function whereToWatch(map: ProviderMap, region: string, services: string[]): WhereToWatch {
  const mineNames = new Set(services.map(norm));
  const seen = new Set<string>();
  const mine: WhereToWatch["mine"] = [];
  const home: WhereToWatch["home"] = [];
  for (const kind of OFFER_KINDS) {
    for (const offer of map[region]?.[kind] ?? []) {
      if (seen.has(offer.name)) continue;
      seen.add(offer.name);
      (STREAM_KINDS.includes(kind) && mineNames.has(norm(offer.name)) ? mine : home).push({ name: offer.name, kind });
    }
  }
  const elsewhere: WhereToWatch["elsewhere"] = [];
  for (const [country, entry] of Object.entries(map)) {
    if (country === region) continue;
    const providers = [...new Set(STREAM_KINDS.flatMap((k) => entry[k].map((o) => o.name)))];
    if (providers.length) elsewhere.push({ country, providers, mine: providers.filter((p) => mineNames.has(norm(p))) });
  }
  elsewhere.sort((a, b) => b.mine.length - a.mine.length || a.country.localeCompare(b.country));
  return { mine, home, elsewhere, link: map[region]?.link ?? "" };
}

/** Provider names found in cached answers for a country, for the list a person ticks their own services from. */
export function providerNames(maps: ProviderMap[], region: string): string[] {
  const names = new Set<string>();
  for (const map of maps) for (const kind of STREAM_KINDS) for (const offer of map[region]?.[kind] ?? []) names.add(offer.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}
