// A briefing prepared for sending: private feeds taken out and rendered as plain text, HTML, Telegram HTML or Discord markdown.
// Every piece of text here came from a feed and is hostile: it is escaped for the format it goes into and never treated as markup.
import type { Briefing } from "../briefing/briefer.ts";
import type { DataTier } from "../store/store.ts";

export interface DigestLink {
  title: string;
  source: string;
  url: string;
}

export interface DigestEntry {
  text: string;
  unchecked: boolean;
  headlineOnly: boolean;
  pinned: boolean;
  links: DigestLink[];
}

export interface DigestSection {
  folder: string;
  entries: DigestEntry[];
  omitted: number;
}

export interface Digest {
  briefingId: number;
  title: string;
  period: string;
  /** Entries that will be sent. */
  entryCount: number;
  sections: DigestSection[];
  /** Entries left out because they come from a private feed. */
  withheld: number;
}

const DAY = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });

/**
 * Takes a stored briefing and the data tier of each item in it. An entry with any private link is withheld unless includePrivate is set;
 * an item whose tier is unknown counts as private.
 */
export function buildDigest(briefing: Briefing, tiers: Map<number, DataTier>, options: { includePrivate: boolean }): Digest {
  let withheld = 0;
  const sections: DigestSection[] = [];
  for (const section of briefing.sections) {
    const entries: DigestEntry[] = [];
    for (const entry of section.entries) {
      const isPrivate = entry.links.some((link) => (tiers.get(link.id) ?? "private") === "private");
      if (isPrivate && !options.includePrivate) {
        withheld++;
        continue;
      }
      entries.push({
        text: entry.text,
        unchecked: !entry.verified && !entry.headlineOnly,
        headlineOnly: entry.headlineOnly,
        pinned: entry.pinned,
        links: entry.links.filter((l) => /^https?:\/\//i.test(l.url)).map((l) => ({ title: l.title, source: l.source, url: l.url })),
      });
    }
    if (entries.length) sections.push({ folder: section.folder || "Unsorted", entries, omitted: section.omitted });
  }
  const created = new Date(briefing.createdAt);
  return {
    briefingId: briefing.id,
    title: `Juhandu: your briefing for ${Number.isNaN(created.getTime()) ? "today" : DAY.format(created)}`,
    period: `${briefing.itemCount} unread item${briefing.itemCount === 1 ? "" : "s"}`,
    entryCount: sections.reduce((n, s) => n + s.entries.length, 0),
    sections,
    withheld,
  };
}

/** A small digest for the Send a test button. */
export function testDigest(): Digest {
  return {
    briefingId: 0,
    title: "Juhandu: a test message",
    period: "If you can read this, delivery works.",
    entryCount: 1,
    sections: [{ folder: "Test", entries: [{ text: "This is what one line of your briefing will look like.", unchecked: false, headlineOnly: false, pinned: false, links: [{ title: "Read the article", source: "Juhandu", url: "https://example.com/" }] }], omitted: 0 }],
    withheld: 0,
  };
}

function label(entry: DigestEntry, link: DigestLink): string {
  return link.title && link.title !== entry.text ? link.title : "Read the article";
}

function withheldLine(d: Digest): string {
  return d.withheld ? `${d.withheld} item${d.withheld === 1 ? "" : "s"} from private feeds ${d.withheld === 1 ? "is" : "are"} not included.` : "";
}

export function renderText(d: Digest): string {
  const out: string[] = [d.title, d.period, ""];
  for (const section of d.sections) {
    out.push(`== ${section.folder} ==`);
    for (const entry of section.entries) {
      out.push(`- ${entry.text}${entry.unchecked ? " (unchecked)" : ""}`);
      for (const link of entry.links) out.push(`  ${label(entry, link)} - ${link.source}: ${link.url}`);
    }
    if (section.omitted) out.push(`  ${section.omitted} more are in Reading.`);
    out.push("");
  }
  const note = withheldLine(d);
  if (note) out.push(note);
  return out.join("\n").trimEnd() + "\n";
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHtml(d: Digest): string {
  const parts: string[] = [
    `<!doctype html><html lang="en"><body style="margin:0;padding:0;background:#f6f0e4;"><div style="max-width:640px;margin:0 auto;padding:24px 20px;font-family:Georgia,'Times New Roman',serif;color:#2b2318;line-height:1.5;">`,
    `<h1 style="font-size:26px;margin:0 0 4px;color:#8a5a00;font-style:italic;">${escapeHtml(d.title)}</h1>`,
    `<p style="margin:0 0 18px;color:#6e5f47;font-size:14px;">${escapeHtml(d.period)}</p>`,
  ];
  for (const section of d.sections) {
    parts.push(`<h2 style="font-size:20px;margin:22px 0 6px;color:#8a5a00;border-top:1px solid #d9ccb4;padding-top:12px;">${escapeHtml(section.folder)}</h2>`);
    for (const entry of section.entries) {
      parts.push(`<p style="margin:12px 0 2px;font-size:17px;">${escapeHtml(entry.text)}${entry.unchecked ? ` <span style="color:#6e5f47;font-size:12px;">(unchecked)</span>` : ""}</p>`);
      for (const link of entry.links) parts.push(`<div style="font-size:14px;margin:0 0 2px;"><a href="${escapeHtml(link.url)}" style="color:#8a5a00;">${escapeHtml(label(entry, link))}</a> <span style="color:#6e5f47;">- ${escapeHtml(link.source)}</span></div>`);
    }
    if (section.omitted) parts.push(`<p style="color:#6e5f47;font-size:14px;">${section.omitted} more are in Reading.</p>`);
  }
  const note = withheldLine(d);
  if (note) parts.push(`<p style="color:#6e5f47;font-size:13px;margin-top:22px;">${escapeHtml(note)}</p>`);
  parts.push("</div></body></html>");
  return parts.join("\n");
}

/** Cuts a block to a limit on a character boundary, with an ellipsis of three dots. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(limit - 3, 0)).trimEnd() + "...";
}

/** Builds one entry's block and drops its last links until it fits, so a long address never gets cut in the middle of a tag or a link. */
function fit(entry: DigestEntry, limit: number, make: (links: DigestLink[]) => string): string {
  let links = entry.links;
  let text = make(links);
  while (text.length > limit && links.length) {
    links = links.slice(0, -1);
    text = make(links);
  }
  return clip(text, limit);
}

/** Fills messages with whole blocks without going over the limit; one block too long for a message is clipped. */
function pack(blocks: string[], limit: number): string[] {
  const messages: string[] = [];
  let current = "";
  for (const raw of blocks) {
    const block = clip(raw, limit);
    if (current && current.length + 1 + block.length > limit) {
      messages.push(current);
      current = block;
    } else {
      current = current ? `${current}\n${block}` : block;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** Telegram HTML mode: only the escaped text and a tags. Messages stay under the 4096 character limit. */
export function renderTelegram(d: Digest): string[] {
  const blocks: string[] = [`<b>${escapeHtml(d.title)}</b>\n${escapeHtml(d.period)}`];
  for (const section of d.sections) {
    blocks.push(`<b>${escapeHtml(section.folder)}</b>`);
    for (const entry of section.entries) {
      blocks.push(
        fit(entry, 3500, (shown) => {
          const links = shown.map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(label(entry, link))}</a> (${escapeHtml(link.source)})`);
          return `\- ${escapeHtml(clip(entry.text, 600))}${entry.unchecked ? " (unchecked)" : ""}${links.length ? "\n" + links.join("\n") : ""}`;
        }),
      );
    }
  }
  const note = withheldLine(d);
  if (note) blocks.push(escapeHtml(note));
  return pack(blocks, 3800);
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~|`>[\]()#-])/g, "\\$1");
}

/** Discord markdown for a webhook. Links are masked and wrapped in angle brackets so they do not unfurl; messages stay under 2000 characters. */
export function renderDiscord(d: Digest): string[] {
  const blocks: string[] = [`**${escapeMarkdown(d.title)}**\n${escapeMarkdown(d.period)}`];
  for (const section of d.sections) {
    blocks.push(`**${escapeMarkdown(section.folder)}**`);
    for (const entry of section.entries) {
      blocks.push(
        fit(entry, 1500, (shown) => {
          const links = shown.map((link) => `[${escapeMarkdown(label(entry, link))}](<${link.url.replace(/[<>()\s]/g, encodeURIComponent)}>) (${escapeMarkdown(link.source)})`);
          return `- ${escapeMarkdown(clip(entry.text, 500))}${entry.unchecked ? " (unchecked)" : ""}${links.length ? "\n" + links.join("\n") : ""}`;
        }),
      );
    }
  }
  const note = withheldLine(d);
  if (note) blocks.push(escapeMarkdown(note));
  return pack(blocks, 1800);
}
