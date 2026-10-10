import { child, children, find, parseXml, textOf } from "./xml.ts";
import type { XmlNode } from "./xml.ts";

export interface ParsedItem {
  guid: string;
  url: string;
  title: string;
  author: string;
  publishedAt: string | null;
  summary: string;
  content: string;
  image: string;
  extra: Record<string, string>;
}

export interface ParsedFeed {
  format: "rss" | "atom" | "rdf" | "jsonfeed";
  title: string;
  siteUrl: string;
  items: ParsedItem[];
}

export class FeedParseError extends Error {}

function toIso(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function firstNonEmpty(...values: string[]): string {
  for (const v of values) if (v) return v;
  return "";
}

function atomLink(entry: XmlNode, rel: string): string {
  const links = children(entry, "link");
  const exact = links.find((l) => (l.attrs["rel"] ?? "alternate") === rel && l.attrs["href"]);
  return exact?.attrs["href"] ?? "";
}

function mediaImage(node: XmlNode): string {
  const thumb = find(node, "media:thumbnail");
  if (thumb?.attrs["url"]) return thumb.attrs["url"];
  const content = children(node, "media:content").find((m) => (m.attrs["medium"] ?? "") === "image" || (m.attrs["type"] ?? "").startsWith("image/"));
  if (content?.attrs["url"]) return content.attrs["url"];
  const enclosure = children(node, "enclosure").find((e) => (e.attrs["type"] ?? "").startsWith("image/"));
  return enclosure?.attrs["url"] ?? "";
}

function parseRssItem(item: XmlNode): ParsedItem {
  const link = textOf(child(item, "link"));
  const guid = firstNonEmpty(textOf(child(item, "guid")), link, textOf(child(item, "title")));
  const extra: Record<string, string> = {};
  const enclosure = children(item, "enclosure")[0];
  if (enclosure?.attrs["url"] && !(enclosure.attrs["type"] ?? "").startsWith("image/")) extra["enclosure"] = enclosure.attrs["url"];
  return {
    guid,
    url: link,
    title: textOf(child(item, "title")),
    author: firstNonEmpty(textOf(child(item, "dc:creator")), textOf(child(item, "author"))),
    publishedAt: toIso(firstNonEmpty(textOf(child(item, "pubDate")), textOf(child(item, "dc:date")), textOf(child(item, "published")))),
    summary: textOf(child(item, "description")),
    content: textOf(child(item, "content:encoded")),
    image: mediaImage(item),
    extra,
  };
}

function parseAtomEntry(entry: XmlNode): ParsedItem {
  const url = atomLink(entry, "alternate");
  const group = child(entry, "media:group");
  const extra: Record<string, string> = {};
  const videoId = textOf(child(entry, "yt:videoId"));
  if (videoId) extra["youtubeVideoId"] = videoId;
  const channelId = textOf(child(entry, "yt:channelId"));
  if (channelId) extra["youtubeChannelId"] = channelId;
  return {
    guid: firstNonEmpty(textOf(child(entry, "id")), url),
    url,
    title: textOf(child(entry, "title")),
    author: textOf(child(child(entry, "author"), "name")),
    publishedAt: toIso(firstNonEmpty(textOf(child(entry, "published")), textOf(child(entry, "updated")))),
    summary: firstNonEmpty(textOf(child(entry, "summary")), textOf(child(group, "media:description"))),
    content: textOf(child(entry, "content")),
    image: mediaImage(group ?? entry),
    extra,
  };
}

function parseJsonFeed(doc: Record<string, unknown>): ParsedFeed {
  const items = Array.isArray(doc["items"]) ? (doc["items"] as Record<string, unknown>[]) : [];
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    format: "jsonfeed",
    title: str(doc["title"]),
    siteUrl: str(doc["home_page_url"]),
    items: items.map((it) => {
      const authors = Array.isArray(it["authors"]) ? (it["authors"] as Record<string, unknown>[]) : [];
      const url = str(it["url"]);
      return {
        guid: firstNonEmpty(str(it["id"]), url),
        url,
        title: str(it["title"]),
        author: str(authors[0]?.["name"]),
        publishedAt: toIso(str(it["date_published"])),
        summary: str(it["summary"]),
        content: firstNonEmpty(str(it["content_html"]), str(it["content_text"])),
        image: firstNonEmpty(str(it["image"]), str(it["banner_image"])),
        extra: {},
      };
    }),
  };
}

/** Parses RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed. Throws FeedParseError when the body is not a feed. */
export function parseFeed(body: string): ParsedFeed {
  const trimmed = body.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("{")) {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      throw new FeedParseError("Body looks like JSON but does not parse");
    }
    if (doc && typeof doc === "object" && typeof (doc as Record<string, unknown>)["version"] === "string" && String((doc as Record<string, unknown>)["version"]).includes("jsonfeed")) {
      return parseJsonFeed(doc as Record<string, unknown>);
    }
    throw new FeedParseError("JSON document is not a JSON Feed");
  }
  const root = parseXml(trimmed);
  const rss = find(root, "rss");
  if (rss) {
    const channel = child(rss, "channel") ?? rss;
    return {
      format: "rss",
      title: textOf(child(channel, "title")),
      siteUrl: textOf(child(channel, "link")),
      items: children(channel, "item").map(parseRssItem),
    };
  }
  const atom = find(root, "feed");
  if (atom) {
    return {
      format: "atom",
      title: textOf(child(atom, "title")),
      siteUrl: atomLink(atom, "alternate"),
      items: children(atom, "entry").map(parseAtomEntry),
    };
  }
  const rdf = find(root, "rdf:RDF");
  if (rdf) {
    const channel = child(rdf, "channel");
    return {
      format: "rdf",
      title: textOf(child(channel, "title")),
      siteUrl: textOf(child(channel, "link")),
      items: children(rdf, "item").map(parseRssItem),
    };
  }
  throw new FeedParseError("Body is not a recognized feed format");
}
