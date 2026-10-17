import { COMMON_FEED_PATHS, discoverFeeds } from "./discover.ts";
import { fetchText, assertHttpUrl } from "./fetcher.ts";
import type { FetchLike } from "./fetcher.ts";
import { FeedParseError, parseFeed } from "./feed-parser.ts";
import type { ParsedFeed } from "./feed-parser.ts";
import { parseYoutubeUrl, resolveYoutubeFeed } from "./youtube.ts";
import type { SourceKind } from "../store/store.ts";
import { isPrivateHost } from "../util/network.ts";

export interface ResolvedSource {
  kind: SourceKind;
  feedUrl: string;
  title: string;
  siteUrl: string;
  feed: ParsedFeed;
}

/** Login headers only go to the address the reader typed, never to other sites a page links to. */
type HeadersFor = (url: string) => Record<string, string>;

async function tryFeed(url: string, fetchImpl: FetchLike, headersFor: HeadersFor): Promise<{ finalUrl: string; feed: ParsedFeed } | null> {
  try {
    const result = await fetchText(url, {}, fetchImpl, undefined, headersFor(url));
    if (result.status >= 400 || !result.body) return null;
    return { finalUrl: result.finalUrl, feed: parseFeed(result.body) };
  } catch (error) {
    if (error instanceof FeedParseError) return null;
    return null;
  }
}

/**
 * Turns whatever the reader pasted (a feed, a site, a YouTube channel) into one feed to subscribe to.
 * Order: YouTube handling, the URL itself, autodiscovery in the page, then common feed paths.
 */
export async function resolveSource(input: string, fetchImpl: FetchLike = fetch, loginHeaders: Record<string, string> = {}): Promise<ResolvedSource> {
  const url = assertHttpUrl(input.trim());
  const headersFor: HeadersFor = (target) => (new URL(target).origin === url.origin ? loginHeaders : {});
  const youtube = parseYoutubeUrl(url.toString());
  if (youtube) {
    const feedUrl = await resolveYoutubeFeed(youtube, fetchImpl);
    const hit = await tryFeed(feedUrl, fetchImpl, () => ({}));
    if (!hit) throw new Error("YouTube did not return a readable feed for that channel");
    return { kind: "youtube", feedUrl, title: hit.feed.title, siteUrl: hit.feed.siteUrl, feed: hit.feed };
  }
  const first = await fetchText(url.toString(), {}, fetchImpl, undefined, loginHeaders);
  if (first.status >= 400) throw new Error(`The site answered HTTP ${first.status}`);
  try {
    const feed = parseFeed(first.body);
    return { kind: "feed", feedUrl: first.finalUrl, title: feed.title, siteUrl: feed.siteUrl, feed };
  } catch (error) {
    if (!(error instanceof FeedParseError)) throw error;
  }
  const candidates = discoverFeeds(first.body, first.finalUrl).map((d) => d.url);
  for (const path of COMMON_FEED_PATHS) candidates.push(new URL(path, first.finalUrl).toString());
  // A page the reader typed may sit on a private network on purpose, but a public page cannot point the search at one.
  const pagePrivate = isPrivateHost(new URL(first.finalUrl).hostname);
  for (const candidate of [...new Set(candidates)]) {
    if (!pagePrivate && isPrivateHost(new URL(candidate).hostname)) continue;
    const hit = await tryFeed(candidate, fetchImpl, headersFor);
    if (hit) return { kind: "feed", feedUrl: hit.finalUrl, title: hit.feed.title, siteUrl: hit.feed.siteUrl || first.finalUrl, feed: hit.feed };
  }
  throw new Error("No feed found at that address");
}
