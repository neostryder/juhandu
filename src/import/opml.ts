// OPML import: the subscriptions and folders from Inoreader or any other reader that exports OPML.
// Nothing is fetched here. The poller picks the new feeds up on its next tick, so a 115-feed file never blocks a request.
import { assertHttpUrl } from "../sources/fetcher.ts";
import { parseXml } from "../sources/xml.ts";
import type { XmlNode } from "../sources/xml.ts";
import { parseYoutubeUrl } from "../sources/youtube.ts";
import type { DataTier, SourceKind, Store } from "../store/store.ts";

export const MAX_OPML_FEEDS = 2000;

export interface OpmlFeed {
  title: string;
  url: string;
  siteUrl: string;
  folder: string;
  kind: SourceKind;
}

export interface OpmlParse {
  feeds: OpmlFeed[];
  /** Outlines that had an address that is not an http or https URL, or a repeat of an earlier one. */
  invalid: { title: string; url: string; reason: string }[];
}

/** Walks the outline tree. A folder is an outline with no feed address; a feed's folder is its nearest folders joined with " / ". */
export function parseOpml(text: string): OpmlParse {
  const root = parseXml(text);
  const body = findBody(root);
  if (!body) throw new Error("That does not look like an OPML file: it has no body");
  const feeds: OpmlFeed[] = [];
  const invalid: OpmlParse["invalid"] = [];
  const seen = new Set<string>();

  const walk = (node: XmlNode, folders: string[]): void => {
    for (const outline of node.children) {
      if (outline.name.toLowerCase() !== "outline") continue;
      const label = (outline.attrs["title"] || outline.attrs["text"] || "").trim();
      const address = (outline.attrs["xmlUrl"] || outline.attrs["xmlurl"] || "").trim();
      if (address) {
        const folder = folders.length ? folders.join(" / ") : (outline.attrs["category"] || "").trim();
        try {
          const url = assertHttpUrl(address).toString();
          if (seen.has(url)) {
            invalid.push({ title: label, url: address, reason: "Listed twice in the file" });
            continue;
          }
          seen.add(url);
          const youtube = parseYoutubeUrl(url);
          feeds.push({ title: label.slice(0, 200), url, siteUrl: (outline.attrs["htmlUrl"] || outline.attrs["htmlurl"] || "").trim().slice(0, 500), folder: folder.slice(0, 80), kind: youtube && youtube.kind !== "page" ? "youtube" : "feed" });
        } catch {
          invalid.push({ title: label, url: address.slice(0, 300), reason: "Not an http or https address" });
        }
      } else {
        walk(outline, label ? [...folders, label] : folders);
      }
    }
  };
  walk(body, []);
  if (feeds.length > MAX_OPML_FEEDS) throw new Error(`That file lists more than ${MAX_OPML_FEEDS} feeds`);
  return { feeds, invalid };
}

function findBody(root: XmlNode): XmlNode | undefined {
  const stack = [root];
  while (stack.length) {
    const node = stack.shift() as XmlNode;
    if (node.name.toLowerCase() === "body") return node;
    stack.push(...node.children);
  }
  return undefined;
}

export interface OpmlPreviewEntry extends OpmlFeed {
  status: "new" | "subscribed";
}

export interface OpmlPreview {
  entries: OpmlPreviewEntry[];
  invalid: OpmlParse["invalid"];
  counts: { total: number; new: number; subscribed: number; invalid: number; folders: number };
}

/** What importing would do, so the user can see it before anything is added. */
export function previewOpml(store: Store, text: string): OpmlPreview {
  const parsed = parseOpml(text);
  const entries = parsed.feeds.map((feed) => ({ ...feed, status: store.findSourceByUrl(feed.url) ? ("subscribed" as const) : ("new" as const) }));
  const fresh = entries.filter((e) => e.status === "new").length;
  return {
    entries,
    invalid: parsed.invalid,
    counts: { total: entries.length, new: fresh, subscribed: entries.length - fresh, invalid: parsed.invalid.length, folders: new Set(entries.map((e) => e.folder)).size },
  };
}

export interface OpmlResult {
  added: number;
  alreadySubscribed: number;
  skipped: number;
  invalid: number;
}

/** Adds the feeds that are not yet subscribed and not in `skip` (feed addresses the user unticked). They are due at once, so the poller fetches them on its next tick. */
export function importOpml(store: Store, text: string, options: { tier?: DataTier; skip?: string[] } = {}): OpmlResult {
  const parsed = parseOpml(text);
  const skip = new Set(options.skip ?? []);
  const result: OpmlResult = { added: 0, alreadySubscribed: 0, skipped: 0, invalid: parsed.invalid.length };
  for (const feed of parsed.feeds) {
    if (store.findSourceByUrl(feed.url)) {
      result.alreadySubscribed++;
      continue;
    }
    if (skip.has(feed.url)) {
      result.skipped++;
      continue;
    }
    store.addSource({ kind: feed.kind, url: feed.url, title: feed.title, siteUrl: feed.siteUrl, folder: feed.folder, tier: options.tier ?? "public" });
    result.added++;
  }
  return result;
}
