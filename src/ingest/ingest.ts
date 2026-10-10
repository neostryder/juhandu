import { fetchText } from "../sources/fetcher.ts";
import type { FetchLike } from "../sources/fetcher.ts";
import { parseFeed } from "../sources/feed-parser.ts";
import type { ParsedItem } from "../sources/feed-parser.ts";
import type { NewItem, Source, Store } from "../store/store.ts";
import type { Credentials } from "../sources/credentials.ts";
import { excerpt, htmlToText, titleHash } from "../text.ts";

const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export interface PollResult {
  sourceId: number;
  status: "updated" | "not-modified" | "error";
  inserted: number;
  error: string | null;
}

/** Time to wait before the next poll: the source's interval, doubled per consecutive failure, capped at a day, never less than Retry-After. */
export function nextDelayMs(pollMinutes: number, errorCount: number, retryAfterSeconds: number | null, random: () => number = Math.random): number {
  const base = pollMinutes * 60_000;
  const backed = errorCount > 0 ? Math.min(base * 2 ** errorCount, MAX_BACKOFF_MS) : base;
  const withRetry = retryAfterSeconds ? Math.max(backed, retryAfterSeconds * 1000) : backed;
  const jitter = 1 + (random() - 0.5) * 0.2;
  return Math.round(Math.min(withRetry * jitter, MAX_BACKOFF_MS));
}

function resolveUrl(raw: string, base: string): string {
  if (!raw) return "";
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

export function toNewItem(item: ParsedItem, base: string): NewItem {
  const contentHtml = item.content || item.summary;
  const text = excerpt(htmlToText(item.summary || item.content));
  const url = resolveUrl(item.url, base);
  const title = htmlToText(item.title) || (text.split("\n")[0] ?? "").slice(0, 120);
  return {
    guid: item.guid || url || title,
    url,
    title,
    author: htmlToText(item.author),
    publishedAt: item.publishedAt,
    summaryText: text,
    contentHtml,
    image: resolveUrl(item.image, base),
    titleHash: titleHash(title),
    extra: item.extra,
  };
}

export class Ingestor {
  private readonly store: Store;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => Date;
  private readonly random: () => number;
  private readonly credentials: Credentials | undefined;

  constructor(store: Store, fetchImpl: FetchLike = fetch, clock: () => Date = () => new Date(), random: () => number = Math.random, credentials?: Credentials) {
    this.credentials = credentials;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.random = random;
  }

  async pollSource(source: Source): Promise<PollResult> {
    const now = this.clock();
    try {
      if (source.auth && !this.credentials) throw new Error("This feed needs a login, but no secret store is set up");
      const access = this.credentials ? await this.credentials.access(source) : { url: source.url, headers: {} };
      const result = await fetchText(access.url, { etag: source.etag, lastModified: source.lastModified }, this.fetchImpl, undefined, access.headers);
      if (result.notModified) {
        this.store.recordPoll(source.id, { etag: source.etag, lastModified: source.lastModified, nextFetchAt: new Date(now.getTime() + nextDelayMs(source.pollMinutes, 0, result.retryAfter, this.random)), error: null, now });
        return { sourceId: source.id, status: "not-modified", inserted: 0, error: null };
      }
      if (result.status >= 400) throw new Error(`HTTP ${result.status}`);
      const feed = parseFeed(result.body);
      const inserted = this.store.upsertItems(
        source.id,
        feed.items.map((i) => toNewItem(i, result.finalUrl)),
        now,
      );
      this.store.recordPoll(source.id, {
        title: source.title ? "" : feed.title,
        siteUrl: source.siteUrl ? "" : feed.siteUrl,
        etag: result.etag,
        lastModified: result.lastModified,
        nextFetchAt: new Date(now.getTime() + nextDelayMs(source.pollMinutes, 0, result.retryAfter, this.random)),
        error: null,
        now,
      });
      return { sourceId: source.id, status: "updated", inserted, error: null };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const message = this.credentials ? this.credentials.redact(raw) : raw;
      this.store.recordPoll(source.id, { etag: source.etag, lastModified: source.lastModified, nextFetchAt: new Date(now.getTime() + nextDelayMs(source.pollMinutes, source.errorCount + 1, null, this.random)), error: message, now });
      return { sourceId: source.id, status: "error", inserted: 0, error: message };
    }
  }

  /** Polls every due source with a small concurrency limit so a slow host never blocks the rest. */
  async pollDue(concurrency = 4): Promise<PollResult[]> {
    const due = this.store.dueSources(this.clock());
    const results: PollResult[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const source = due[cursor++];
        if (!source) return;
        results.push(await this.pollSource(source));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
    return results;
  }
}
