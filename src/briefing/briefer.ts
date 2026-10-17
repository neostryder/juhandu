import type { BriefingItem, Store } from "../store/store.ts";

export type BriefingKind = "daily" | "ondemand" | "catchup";

export interface BriefingLink {
  id: number;
  title: string;
  source: string;
  url: string;
}

export interface BriefingEntry {
  kind: "story" | "item";
  text: string;
  /** False when the line is a model summary whose supporting quote was not found in the source, or an unverified merged line. */
  verified: boolean;
  /** True when the line is only the headline, because no summary exists for the item. */
  headlineOnly: boolean;
  pinned: boolean;
  links: BriefingLink[];
  storyId?: number;
  /** True when the merged line was written from a story that has a private member, even one outside this briefing. Outside the app the line is treated as private. Briefings saved before this field existed leave it out, and a story line without it counts as private. */
  private?: boolean;
}

export interface BriefingSection {
  folder: string;
  entries: BriefingEntry[];
  /** Entries cut by the per-folder cap. */
  omitted: number;
}

export interface Briefing {
  id: number;
  kind: BriefingKind;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  itemCount: number;
  sections: BriefingSection[];
}

export interface BuildOptions {
  kind: BriefingKind;
  /** Window length in hours for daily and on-demand briefings. */
  hours?: number;
  /** Entries kept per folder; the rest are counted, not listed. */
  perFolder?: number;
}

const DEFAULT_HOURS = 24;
const CAPS: Record<BriefingKind, number> = { daily: 12, ondemand: 12, catchup: 8 };

interface Group {
  members: BriefingItem[];
  storyId: number | null;
}

function rank(group: Group): [number, number, number] {
  const taste = Math.max(...group.members.map((m) => m.taste ?? 0));
  const when = Math.max(...group.members.map((m) => m.whenMs));
  return [group.members.some((m) => m.pinned) ? 1 : 0, taste, when];
}

function compareGroups(a: Group, b: Group): number {
  const ra = rank(a);
  const rb = rank(b);
  return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2];
}

/** Builds a briefing from what is already stored: summaries, merged stories, rule decisions and shadow taste. It calls no model, so it is instant and never fails for lack of one. */
export class Briefer {
  private readonly store: Store;
  private readonly clock: () => Date;

  constructor(store: Store, clock: () => Date = () => new Date()) {
    this.store = store;
    this.clock = clock;
  }

  build(options: BuildOptions): Briefing {
    const now = this.clock();
    const until = now.getTime();
    const since = options.kind === "catchup" ? 0 : until - (options.hours ?? DEFAULT_HOURS) * 3_600_000;
    const items = this.store.briefingItems(since, until);
    const cap = options.perFolder ?? CAPS[options.kind];

    // A story is shown as one entry in the folder of its newest unread member, and only when two or more of its members are in this window.
    const byStory = new Map<number, BriefingItem[]>();
    for (const item of items) if (item.storyId !== null) byStory.set(item.storyId, [...(byStory.get(item.storyId) ?? []), item]);
    const groups: Group[] = [];
    for (const item of items) {
      if (item.storyId !== null && (byStory.get(item.storyId)?.length ?? 0) >= 2) continue;
      groups.push({ members: [item], storyId: null });
    }
    for (const [storyId, members] of byStory) if (members.length >= 2) groups.push({ members, storyId });

    const byFolder = new Map<string, Group[]>();
    for (const group of groups) {
      const newest = group.members.reduce((a, b) => (b.whenMs > a.whenMs ? b : a));
      const folder = newest.folder.trim() || "Unsorted";
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), group]);
    }

    const sections: BriefingSection[] = [...byFolder.entries()]
      .map(([folder, list]) => {
        const sorted = list.sort(compareGroups);
        return { folder, sorted, entries: sorted.slice(0, cap).map((g) => this.entry(g)), omitted: Math.max(sorted.length - cap, 0) };
      })
      .sort((a, b) => compareGroups(a.sorted[0] as Group, b.sorted[0] as Group) || a.folder.localeCompare(b.folder))
      .map(({ folder, entries, omitted }) => ({ folder, entries, omitted }));

    const itemCount = items.length;
    const periodStart = new Date(since).toISOString();
    const periodEnd = now.toISOString();
    const body = JSON.stringify(sections);
    const id = this.store.saveBriefing({ kind: options.kind, periodStart, periodEnd, itemCount, body }, now);
    return { id, kind: options.kind, periodStart, periodEnd, createdAt: now.toISOString(), itemCount, sections };
  }

  private entry(group: Group): BriefingEntry {
    const links = [...group.members].sort((a, b) => a.whenMs - b.whenMs).map((m) => ({ id: m.id, title: m.title, source: m.sourceTitle, url: m.url }));
    const pinned = group.members.some((m) => m.pinned);
    if (group.storyId !== null) {
      const story = this.store.getStory(group.storyId);
      if (story?.summary) {
        const hasPrivateMember = this.store.storyMembers(group.storyId).some((m) => m.tier === "private");
        return { kind: "story", text: story.summary, verified: story.verified, headlineOnly: false, pinned, links, storyId: group.storyId, private: hasPrivateMember };
      }
      const best = group.members.find((m) => m.summary) ?? group.members[0]!;
      return { kind: "story", text: best.summary?.text ?? best.title, verified: best.summary?.verified ?? false, headlineOnly: !best.summary, pinned, links, storyId: group.storyId, private: false };
    }
    const item = group.members[0] as BriefingItem;
    return { kind: "item", text: item.summary?.text ?? item.title, verified: item.summary?.verified ?? false, headlineOnly: !item.summary, pinned, links };
  }

  get(id: number): Briefing | null {
    const row = this.store.getBriefing(id);
    if (!row) return null;
    return { id: row.id, kind: row.kind as BriefingKind, periodStart: row.periodStart, periodEnd: row.periodEnd, createdAt: row.createdAt, itemCount: row.itemCount, sections: JSON.parse(row.body) as BriefingSection[] };
  }
}

/** Plain markdown, for pushing a briefing to email, Telegram or Discord later and for reading in a terminal. Every line carries its source links. */
export function renderMarkdown(briefing: Briefing): string {
  const title = briefing.kind === "catchup" ? "Catch-up briefing" : "Briefing";
  const lines = [`# ${title}`, `${briefing.itemCount} unread items from ${briefing.periodStart.slice(0, 10)} to ${briefing.periodEnd.slice(0, 10)}.`, ""];
  for (const section of briefing.sections) {
    lines.push(`## ${section.folder}`);
    for (const entry of section.entries) {
      const links = entry.links.map((l) => `[${l.source || "source"}](${l.url})`).join(", ");
      lines.push(`- ${entry.pinned ? "(pinned) " : ""}${entry.text}${entry.verified || entry.headlineOnly ? "" : " (unchecked)"} ${links}`);
    }
    if (section.omitted) lines.push(`- ${section.omitted} more in this folder`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
