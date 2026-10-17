// Video lengths for the duration rule: the YouTube Data API when a key is set, the video's own page otherwise. Only public-tier items are looked up.
import { fetchText } from "../sources/fetcher.ts";
import type { FetchLike } from "../sources/fetcher.ts";
import { watchUrl } from "./ids.ts";

const API = "https://www.googleapis.com/youtube/v3/videos";
const BATCH = 50;
const PAGE_BATCH = 10;
const PAUSE_MS = 3_600_000;
const MISSES_BEFORE_GIVING_UP = 3;

/** The length stored for a video that has none to give (private, removed, or a live stream), so it is never asked about again. */
export const NO_DURATION = -1;

/** Seconds in an ISO 8601 duration such as PT4M13S or P1DT2H; null when the text is not one. */
export function parseIsoDuration(text: string): number | null {
  const m = text.trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m || text.trim() === "P" || text.trim().endsWith("T")) return null;
  return Math.round(Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0));
}

/** The length a watch page states, from its duration meta tag or its player data; null when neither is there. */
export function durationFromWatchPage(html: string): number | null {
  const meta = html.match(/<meta[^>]+itemprop=["']duration["'][^>]+content=["']([^"']+)["']/i) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']duration["']/i);
  if (meta) {
    const seconds = parseIsoDuration(meta[1] as string);
    if (seconds !== null) return seconds;
  }
  const length = html.match(/"lengthSeconds":"(\d+)"/);
  return length ? Number(length[1]) : null;
}

export interface VideoDurationOptions {
  /** The Data API key, read each time so a newly saved key is used without a restart. */
  apiKey?: () => string | undefined;
  fetchImpl?: FetchLike;
  clock?: () => number;
}

/** Looks up video lengths. A video it cannot get a length for comes back as NO_DURATION once it has been tried enough; one it could not reach this time is left out and asked about again later. */
export class VideoDurations {
  private readonly apiKey: () => string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => number;
  private pausedUntil = 0;
  private pausedKey = "";
  private readonly misses = new Map<string, number>();

  constructor(options: VideoDurationOptions = {}) {
    this.apiKey = options.apiKey ?? (() => undefined);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  /** Which source the next lookup uses, for the start-up log and the settings screen. */
  mode(): "api" | "page" {
    const key = this.apiKey();
    return key && !(this.clock() < this.pausedUntil && key === this.pausedKey) ? "api" : "page";
  }

  async lookup(ids: string[]): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    const unique = [...new Set(ids)];
    if (!unique.length) return found;
    const key = this.apiKey();
    if (key && !(this.clock() < this.pausedUntil && key === this.pausedKey)) {
      for (let i = 0; i < unique.length; i += BATCH) {
        const chunk = unique.slice(i, i + BATCH);
        try {
          const lengths = await this.fromApi(chunk, key);
          for (const id of chunk) found.set(id, lengths.get(id) ?? NO_DURATION);
        } catch (error) {
          if (error instanceof KeyRefused) {
            this.pausedUntil = this.clock() + PAUSE_MS;
            this.pausedKey = key;
            break;
          }
          return found;
        }
      }
      if (found.size === unique.length) return found;
    }
    const rest = unique.filter((id) => !found.has(id)).slice(0, PAGE_BATCH);
    for (const id of rest) {
      const seconds = await this.fromPage(id);
      if (seconds !== null) found.set(id, seconds);
    }
    return found;
  }

  private async fromApi(ids: string[], key: string): Promise<Map<string, number>> {
    const url = `${API}?part=contentDetails&maxResults=${BATCH}&id=${ids.join(",")}`;
    const response = await this.fetchImpl(url, { headers: { "x-goog-api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new KeyRefused();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The YouTube API answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as { items?: { id?: string; contentDetails?: { duration?: string } }[] };
    const out = new Map<string, number>();
    for (const item of body.items ?? []) {
      const seconds = item.contentDetails?.duration ? parseIsoDuration(item.contentDetails.duration) : null;
      if (item.id) out.set(item.id, seconds && seconds > 0 ? seconds : NO_DURATION);
    }
    return out;
  }

  private async fromPage(id: string): Promise<number | null> {
    let seconds: number | null = null;
    try {
      const page = await fetchText(watchUrl(id), {}, this.fetchImpl, 15_000);
      if (page.status === 404 || page.status === 410) return NO_DURATION;
      if (page.status < 400) seconds = durationFromWatchPage(page.body);
    } catch {
      return null;
    }
    if (seconds !== null) {
      this.misses.delete(id);
      return seconds > 0 ? seconds : NO_DURATION;
    }
    const count = (this.misses.get(id) ?? 0) + 1;
    if (count >= MISSES_BEFORE_GIVING_UP) {
      this.misses.delete(id);
      return NO_DURATION;
    }
    this.misses.set(id, count);
    return null;
  }
}

class KeyRefused extends Error {}

type Env = Record<string, string | undefined>;

/** The duration lookup for this environment, or null when JUHANDU_DURATIONS=off. JUHANDU_YOUTUBE_API_KEY switches it from reading each video's page to the Data API. */
export function buildVideoDurations(env: Env, fetchImpl?: FetchLike): VideoDurations | null {
  if (env["JUHANDU_DURATIONS"] === "off") return null;
  return new VideoDurations({ apiKey: () => env["JUHANDU_YOUTUBE_API_KEY"] || undefined, ...(fetchImpl ? { fetchImpl } : {}) });
}
