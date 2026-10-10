import { decodeEntities } from "./xml.ts";

export interface DiscoveredFeed {
  url: string;
  title: string;
  type: string;
}

const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/feed+json", "application/json", "application/rdf+xml", "text/xml", "application/xml"]);

/** Finds feed links advertised in an HTML page's head (feed autodiscovery). */
export function discoverFeeds(html: string, pageUrl: string): DiscoveredFeed[] {
  const found: DiscoveredFeed[] = [];
  const seen = new Set<string>();
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      attrs[(m[1] as string).toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
    }
    const rels = (attrs["rel"] ?? "").toLowerCase().split(/\s+/);
    const type = (attrs["type"] ?? "").toLowerCase();
    const href = attrs["href"];
    if (!href || !rels.includes("alternate") || !FEED_TYPES.has(type)) continue;
    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    found.push({ url: absolute, title: attrs["title"] ?? "", type });
  }
  return found;
}

/** Paths worth trying when a page advertises nothing. */
export const COMMON_FEED_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml", "/feeds/posts/default"];
