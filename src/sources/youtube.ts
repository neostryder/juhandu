import type { FetchLike } from "./fetcher.ts";
import { fetchText } from "./fetcher.ts";

export type YoutubeRef = { kind: "channel"; id: string } | { kind: "playlist"; id: string } | { kind: "page"; url: string };

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

/** Recognizes YouTube channel and playlist URLs. Handles (/@name), /user/ and /c/ pages need a page fetch to find the channel id. */
export function parseYoutubeUrl(raw: string): YoutubeRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(url.hostname)) return null;
  const channel = url.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/|$)/);
  if (channel) return { kind: "channel", id: channel[1] as string };
  if (url.pathname === "/feeds/videos.xml") {
    const id = url.searchParams.get("channel_id");
    if (id) return { kind: "channel", id };
    const list = url.searchParams.get("playlist_id");
    if (list) return { kind: "playlist", id: list };
  }
  const playlist = url.pathname === "/playlist" ? url.searchParams.get("list") : null;
  if (playlist) return { kind: "playlist", id: playlist };
  if (/^\/(@[^/]+|user\/[^/]+|c\/[^/]+)/.test(url.pathname)) return { kind: "page", url: url.origin + url.pathname.split("/").slice(0, url.pathname.startsWith("/@") ? 2 : 3).join("/") };
  return null;
}

export function youtubeFeedUrl(ref: { kind: "channel" | "playlist"; id: string }): string {
  const key = ref.kind === "channel" ? "channel_id" : "playlist_id";
  return `https://www.youtube.com/feeds/videos.xml?${key}=${ref.id}`;
}

/** Finds the channel id on a channel page without the Data API. */
export function extractChannelId(html: string): string | null {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})["']/i,
    /<meta[^>]+itemprop=["']identifier["'][^>]+content=["'](UC[\w-]{22})["']/i,
    /"externalId":"(UC[\w-]{22})"/,
    /"channelId":"(UC[\w-]{22})"/,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return m[1] as string;
  }
  return null;
}

export async function resolveYoutubeFeed(ref: YoutubeRef, fetchImpl: FetchLike = fetch): Promise<string> {
  if (ref.kind !== "page") return youtubeFeedUrl(ref);
  const page = await fetchText(ref.url, {}, fetchImpl);
  if (page.status >= 400) throw new Error(`YouTube page answered HTTP ${page.status}`);
  const id = extractChannelId(page.body);
  if (!id) throw new Error("Could not find a channel id on that YouTube page");
  return youtubeFeedUrl({ kind: "channel", id });
}
