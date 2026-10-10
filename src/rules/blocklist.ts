import { hostOf } from "./rules.ts";
import type { DomainCondition, KeywordCondition, RuleField, RuleScope } from "./rules.ts";

/** Blocklist import: plain word lists and domain lists are parsed into entries, previewed against the newest items, and turned into hard-block rules. */

export type ListFormat = "words" | "domains";

export const MAX_LIST_ENTRIES = 20_000;
const MAX_WORD_LENGTH = 120;
/** One rule per line is a convenience for short lists; past this the list becomes one rule. */
export const MAX_RULES_PER_IMPORT = 500;

export interface SkippedLine {
  line: number;
  text: string;
  reason: string;
}

export interface ParsedList {
  entries: string[];
  skipped: SkippedLine[];
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** One word or phrase per line. A line starting with "# " (or only "#") is a comment, so "#hashtag" is still a word. Matching is case-insensitive, like keyword rules. */
function parseWords(text: string): ParsedList {
  const entries: string[] = [];
  const skipped: SkippedLine[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).trim();
    if (!raw || raw === "#" || raw.startsWith("# ") || raw.startsWith("//")) continue;
    const word = raw.replace(/\s+/g, " ");
    if (word.length > MAX_WORD_LENGTH) {
      skipped.push({ line: i + 1, text: clip(word), reason: `longer than ${MAX_WORD_LENGTH} characters` });
      continue;
    }
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    if (entries.length >= MAX_LIST_ENTRIES) {
      skipped.push({ line: i + 1, text: clip(word), reason: `past the ${MAX_LIST_ENTRIES} entry limit` });
      continue;
    }
    seen.add(key);
    entries.push(word);
  }
  return { entries, skipped };
}

/** Reads the common domain list shapes: a bare domain, a hosts-file line ("0.0.0.0 example.com"), an Adblock-style "||example.com^", a "*.example.com" wildcard or a full URL. Comments, headers and exception rules are not entries. */
function parseDomains(text: string): ParsedList {
  const entries: string[] = [];
  const skipped: SkippedLine[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let raw = (lines[i] as string).trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("!") || raw.startsWith("[")) continue;
    if (raw.startsWith("@@")) {
      skipped.push({ line: i + 1, text: clip(raw), reason: "an exception rule, which is not supported" });
      continue;
    }
    raw = raw.replace(/\s+#.*$/, "");
    const hosts = raw.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)/);
    let candidate = hosts ? (hosts[1] as string) : raw;
    candidate = candidate.replace(/^\|\|/, "").replace(/\$.*$/, "").replace(/\^.*$/, "").replace(/^\*\./, "");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = hostOf(candidate) || candidate;
    candidate = candidate.replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
    if (candidate === "localhost" || IPV4.test(candidate) || !DOMAIN.test(candidate)) {
      skipped.push({ line: i + 1, text: clip(raw), reason: "not a domain name" });
      continue;
    }
    if (seen.has(candidate)) continue;
    if (entries.length >= MAX_LIST_ENTRIES) {
      skipped.push({ line: i + 1, text: clip(raw), reason: `past the ${MAX_LIST_ENTRIES} entry limit` });
      continue;
    }
    seen.add(candidate);
    entries.push(candidate);
  }
  return { entries, skipped };
}

export function parseList(format: ListFormat, text: string): ParsedList {
  return format === "domains" ? parseDomains(text) : parseWords(text);
}

/** The slice of an item a list is matched against. */
export interface ListItem {
  id: number;
  title: string;
  text: string;
  author: string;
  url: string;
}

export interface EntryPreview {
  entry: string;
  matched: number;
  /** Up to three titles it would hide, so a surprising entry is easy to spot. */
  titles: string[];
}

export interface ListPreview {
  entries: EntryPreview[];
  /** Items examined. */
  total: number;
  /** Items hidden by at least one entry. */
  wouldHide: number;
}

/** Counts, for each entry, how many of the given items it would hide, with the same matching the rules use (words: case-insensitive substring in the chosen fields; domains: the link's host or a subdomain of it). */
export function previewList(format: ListFormat, entries: string[], items: ListItem[], fields: RuleField[]): ListPreview {
  const out = new Map<string, EntryPreview>(entries.map((entry) => [entry, { entry, matched: 0, titles: [] }]));
  const hit = new Set<number>();
  const note = (entry: string, item: ListItem): void => {
    const row = out.get(entry);
    if (!row) return;
    row.matched++;
    if (row.titles.length < 3) row.titles.push(item.title);
    hit.add(item.id);
  };
  if (format === "domains") {
    const known = new Set(entries);
    for (const item of items) {
      const labels = hostOf(item.url).split(".");
      for (let i = 0; i < labels.length - 1; i++) {
        const candidate = labels.slice(i).join(".");
        if (known.has(candidate)) {
          note(candidate, item);
          break;
        }
      }
    }
  } else {
    const lowered = entries.map((entry) => ({ entry, term: entry.toLowerCase() }));
    for (const item of items) {
      const haystack = fields.map((f) => item[f]).join("\n").toLowerCase();
      for (const { entry, term } of lowered) if (haystack.includes(term)) note(entry, item);
    }
  }
  return { entries: [...out.values()].sort((a, b) => b.matched - a.matched), total: items.length, wouldHide: hit.size };
}

export interface ImportOptions {
  format: ListFormat;
  /** "list" makes one rule holding every entry; "each" makes one rule per entry. */
  group: "list" | "each";
  name: string;
  scope: RuleScope;
  fields: RuleField[];
}

export interface PlannedRule {
  kind: "block";
  scope: RuleScope;
  condition: KeywordCondition | DomainCondition;
  status: "active";
  origin: "user";
  note: string;
}

/** The hard-block rules an import creates. Entries an existing block rule already holds are left out and returned, so importing a list twice adds nothing. */
export function planImport(entries: string[], options: ImportOptions, existing: { kind: string; status: string; condition: { type: string; terms?: string[]; domains?: string[] } }[]): { rules: PlannedRule[]; alreadyCovered: string[] } {
  const covered = new Set<string>();
  for (const rule of existing) {
    if (rule.kind !== "block" || rule.status === "disabled") continue;
    if (options.format === "words" && rule.condition.type === "keyword") for (const t of rule.condition.terms ?? []) covered.add(t.trim().toLowerCase());
    if (options.format === "domains" && rule.condition.type === "domain") for (const d of rule.condition.domains ?? []) covered.add(d.toLowerCase());
  }
  const fresh = entries.filter((e) => !covered.has(e.toLowerCase()));
  const alreadyCovered = entries.filter((e) => covered.has(e.toLowerCase()));
  const base = { kind: "block" as const, scope: options.scope, status: "active" as const, origin: "user" as const };
  const make = (list: string[], note: string): PlannedRule => ({ ...base, note, condition: options.format === "domains" ? { type: "domain", domains: list } : { type: "keyword", terms: list, mode: "any", fields: options.fields } });
  if (!fresh.length) return { rules: [], alreadyCovered };
  if (options.group === "each" && fresh.length <= MAX_RULES_PER_IMPORT) return { rules: fresh.map((e) => make([e], options.name)), alreadyCovered };
  return { rules: [make(fresh, options.name)], alreadyCovered };
}
