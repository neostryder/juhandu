// OPML import: the subscriptions and folders from Inoreader or any other reader that exports OPML.
// Nothing is fetched here. The poller picks the new feeds up on its next tick, so a 115-feed file never blocks a request.
import { createHash } from "node:crypto";
import { assertHttpUrl } from "../sources/fetcher.ts";
import { maskUrl } from "../sources/credentials.ts";
import type { Credentials } from "../sources/credentials.ts";
import { parseXml } from "../sources/xml.ts";
import type { XmlNode } from "../sources/xml.ts";
import { parseYoutubeUrl } from "../sources/youtube.ts";
import type { DataTier, SourceKind, Store } from "../store/store.ts";

export const MAX_OPML_FEEDS = 2000;

const LOGIN_PARAM = /token|secret|passw|pwd|apikey|api[-_]key|auth|signature|slurm|session|^(key|sig|sid|hash)$/i;

/** Whether an address looks like a private link: a name and password before the host, or a query value under a name that usually holds a token or key. */
export function carriesLogin(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return true;
    for (const [name, value] of parsed.searchParams) if (value && LOGIN_PARAM.test(name)) return true;
  } catch {
    return false;
  }
  return false;
}

/** A stable, safe stand-in for a private link, so a preview and a skip list can name the feed without repeating its address. */
export function linkKey(url: string): string {
  return `${new URL(url).origin}/***#secret-${createHash("sha256").update(url).digest("hex").slice(0, 10)}`;
}

export interface OpmlFeed {
  title: string;
  url: string;
  siteUrl: string;
  folder: string;
  kind: SourceKind;
  /** True when the address carries a login. Such a feed is stored as a masked private link and its address lives in the secret store. */
  privateLink: boolean;
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
            invalid.push({ title: label, url: carriesLogin(url) ? linkKey(url) : address, reason: "Listed twice in the file" });
            continue;
          }
          seen.add(url);
          const youtube = parseYoutubeUrl(url);
          feeds.push({ title: label.slice(0, 200), url, siteUrl: (outline.attrs["htmlUrl"] || outline.attrs["htmlurl"] || "").trim().slice(0, 500), folder: folder.slice(0, 80), kind: youtube && youtube.kind !== "page" ? "youtube" : "feed", privateLink: carriesLogin(url) });
        } catch {
          invalid.push({ title: label, url: carriesLogin(address) ? "(address withheld: it carries a login)" : address.slice(0, 300), reason: "Not an http or https address" });
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
export async function previewOpml(store: Store, text: string, credentials?: Credentials): Promise<OpmlPreview> {
  const parsed = parseOpml(text);
  const sources = store.listSources();
  const entries: OpmlPreviewEntry[] = [];
  for (const feed of parsed.feeds) {
    const known = feed.privateLink ? (credentials ? await credentials.findByLink(sources, feed.url) : undefined) : store.findSourceByUrl(feed.url);
    entries.push({ ...feed, url: feed.privateLink ? linkKey(feed.url) : feed.url, status: known ? "subscribed" : "new" });
  }
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
  /** Private links left out because no secret store is set up to hold their login. */
  withheld: number;
}

/** Adds the feeds that are not yet subscribed and not in `skip` (feed addresses, or the stand-in a preview showed for a private link, that the user unticked). They are due at once, so the poller fetches them on its next tick. A feed whose address carries a login is stored as a masked private link in the private tier with its address in the secret store; without a secret store it is left out rather than stored in the clear. */
export async function importOpml(store: Store, text: string, options: { tier?: DataTier; skip?: string[]; credentials?: Credentials } = {}): Promise<OpmlResult> {
  const parsed = parseOpml(text);
  const skip = new Set(options.skip ?? []);
  const result: OpmlResult = { added: 0, alreadySubscribed: 0, skipped: 0, invalid: parsed.invalid.length, withheld: 0 };
  const sources = store.listSources();
  for (const feed of parsed.feeds) {
    if (feed.privateLink) {
      if (!options.credentials) {
        result.withheld++;
        continue;
      }
      if (await options.credentials.findByLink(sources, feed.url)) {
        result.alreadySubscribed++;
        continue;
      }
      if (skip.has(feed.url) || skip.has(linkKey(feed.url))) {
        result.skipped++;
        continue;
      }
      const source = store.addSource({ kind: feed.kind, url: maskUrl(feed.url), title: feed.title, siteUrl: feed.siteUrl, folder: feed.folder, tier: "private", auth: "url" });
      try {
        await options.credentials.save(source.id, { kind: "url", url: feed.url });
      } catch (error) {
        store.removeSource(source.id);
        throw new Error(options.credentials.redact(error instanceof Error ? error.message : "Could not store a feed login"));
      }
      result.added++;
      continue;
    }
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
