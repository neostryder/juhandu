import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Rule, RuleCondition, RuleHit, RuleKind, RuleOrigin, RuleScope, RuleStatus } from "../rules/rules.ts";
import type { PipeDoc } from "../pipes/pipe.ts";
import { fromBlob, toBlob } from "../taste/vectors.ts";

export type DataTier = "public" | "private";
export type SourceKind = "feed" | "youtube";

export interface Source {
  id: number;
  kind: SourceKind;
  url: string;
  title: string;
  siteUrl: string;
  folder: string;
  tier: DataTier;
  etag: string | null;
  lastModified: string | null;
  lastFetchedAt: string | null;
  nextFetchAt: string;
  errorCount: number;
  lastError: string | null;
  pollMinutes: number;
  createdAt: string;
  /** The kind of login this feed needs, when it needs one. The login itself lives only in the SecretStore. */
  auth: "url" | "basic" | "header" | "cookie" | null;
}

export interface NewItem {
  guid: string;
  url: string;
  title: string;
  author: string;
  publishedAt: string | null;
  summaryText: string;
  contentHtml: string;
  image: string;
  titleHash: string;
  extra: Record<string, string>;
}

export interface StoredDecision {
  verdict: "show" | "hide";
  hideReason: "block" | "soft" | null;
  pinned: boolean;
  score: number;
  taste: number | null;
  hits: RuleHit[];
  incomplete: boolean;
  restored: boolean;
}

/** One-line summary of an item, written by a model from the item's own text. */
export interface StoredSummary {
  text: string;
  /** A phrase copied from the source that backs the summary. */
  evidence: string;
  /** True when the evidence phrase was found verbatim in the source text. */
  verified: boolean;
  /** True when the source text looked like it was addressing the model. */
  suspicious: boolean;
  model: string;
}

export interface VideoReadingWrite {
  status: "ok" | "none" | "failed";
  rung?: string;
  model?: string;
  text?: string;
  transcript?: string;
  /** Why no rung could read it, in a sentence. */
  note?: string;
  durationSec?: number;
}

export interface StoredVideoReading {
  itemId: number;
  status: "ok" | "none" | "failed";
  rung: string;
  model: string;
  text: string;
  transcript: string;
  note: string;
  attempts: number;
  durationSec: number | null;
  createdAt: string;
}

/** A video item's address, as the SQL sees it. The reader confirms the id in code and marks anything it cannot read as none. */
const VIDEO_URL = `(i.url LIKE '%youtube.com/watch%' OR i.url LIKE '%youtu.be/%' OR i.url LIKE '%youtube.com/shorts/%' OR i.url LIKE '%youtube.com/live/%')`;
/** A failed reading is tried again after this long, so a video that is briefly unavailable is not hammered. */
const VIDEO_RETRY_MS = 20 * 60_000;

export interface SummaryWrite {
  status: "ok" | "skipped" | "failed";
  text?: string;
  evidence?: string;
  verified?: boolean;
  suspicious?: boolean;
  model?: string;
  promptVersion: number;
}

export const MAX_SUMMARY_ATTEMPTS = 3;
export const MAX_VIDEO_ATTEMPTS = 3;

/** A shown item with its vector, as the story merger needs it. */
export interface MergeItem {
  id: number;
  sourceId: number;
  tier: DataTier;
  title: string;
  /** Milliseconds since the epoch of the publish time, or the fetch time when the feed gave none. */
  whenMs: number;
  vector: Float32Array;
  storyId: number | null;
}

export interface StoryMember {
  itemId: number;
  sourceTitle: string;
  url: string;
  title: string;
  text: string;
  tier: DataTier;
}

export interface StoredStory {
  id: number;
  summary: string;
  evidence: string;
  verified: boolean;
  model: string;
}

/** What the briefing builder reads: one shown, unread item with everything its entry needs. */
export interface BriefingItem {
  id: number;
  folder: string;
  sourceTitle: string;
  url: string;
  title: string;
  whenMs: number;
  summary: StoredSummary | null;
  pinned: boolean;
  taste: number | null;
  storyId: number | null;
}

export interface StoredBriefing {
  id: number;
  kind: string;
  periodStart: string;
  periodEnd: string;
  itemCount: number;
  body: string;
  createdAt: string;
}

export interface Item extends Omit<NewItem, "contentHtml"> {
  id: number;
  sourceId: number;
  sourceTitle: string;
  fetchedAt: string;
  read: boolean;
  /** 1 liked, -1 disliked, 0 no vote. */
  vote: number;
  voteReason: string;
  decision: StoredDecision | null;
  summary: StoredSummary | null;
  /** What the video says, when the VideoReader has read this item. */
  video: { text: string; rung: string } | null;
}

/** inbox: shown items and items not yet judged; filtered: hidden items (the Filtered-out view); all: both. */
export type ItemView = "inbox" | "filtered" | "all";

export interface ItemQuery {
  limit?: number;
  /** The id of the last item of the previous page; the page that follows is the items after it in the list's own order (newest first). An unknown id returns nothing. */
  beforeId?: number;
  sourceId?: number;
  /** Items from any of these sources (pipes read several at once). */
  sourceIds?: number[];
  /** Allow a larger page than the reading list's 200, for a pipe's input. */
  wide?: boolean;
  unreadOnly?: boolean;
  view?: ItemView;
  itemId?: number;
}

export interface NewRule {
  kind: RuleKind;
  scope: RuleScope;
  condition: RuleCondition;
  weight?: number;
  status?: RuleStatus;
  origin?: RuleOrigin;
  note?: string;
}

export interface NewProposal {
  signature: string;
  evidenceKey: string;
  kind: RuleKind;
  scope: RuleScope;
  condition: RuleCondition;
  weight: number;
  rationale: string;
  /** Item ids of the votes the rule was drafted from. */
  evidence: number[];
  stats: Record<string, unknown>;
  /** "code" when a plain count found it, "model" when a model drafted it from votes and reasons. */
  origin: "code" | "model";
  model: string;
}

export interface Proposal extends NewProposal {
  id: number;
  status: "pending" | "accepted" | "rejected";
  ruleId: number | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface VotedItem {
  id: number;
  sourceId: number;
  sourceTitle: string;
  folder: string;
  tier: DataTier;
  url: string;
  title: string;
  author: string;
  text: string;
  vote: number;
  reason: string;
  votedAt: string;
}

export interface PendingItem {
  id: number;
  sourceId: number;
  url: string;
  folder: string;
  tier: DataTier;
  title: string;
  author: string;
  text: string;
}

export interface JudgmentEntry {
  kind: string;
  question: string;
  input: unknown;
  output: unknown;
  model: string;
  provider: string;
  priority: string;
  tier: DataTier;
  /** "acted" when the answer was used, "shadow" when it was only recorded beside the one that was. Missing means acted. */
  role?: string;
  /** The family of question this belongs to (same_story, pipe_ask, wants), so each can be exported and trained as its own model. Missing means none. */
  lane?: string;
}

export interface StoredJudgment extends JudgmentEntry {
  id: number;
  createdAt: string;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE reader (id INTEGER PRIMARY KEY CHECK (id = 1), created_at TEXT NOT NULL);
  INSERT INTO reader (id, created_at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    site_url TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    tier TEXT NOT NULL DEFAULT 'public',
    etag TEXT,
    last_modified TEXT,
    last_fetched_at TEXT,
    next_fetch_at TEXT NOT NULL,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    poll_minutes INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    fetched_at TEXT NOT NULL,
    summary_text TEXT NOT NULL DEFAULT '',
    content_html TEXT NOT NULL DEFAULT '',
    image TEXT NOT NULL DEFAULT '',
    title_hash TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '{}',
    is_read INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source_id, guid)
  );
  CREATE INDEX items_order ON items (published_at DESC, id DESC);
  CREATE INDEX items_title_hash ON items (title_hash);
  `,
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta (key, value) VALUES ('rules_version', '1');
  CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    condition TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    origin TEXT NOT NULL DEFAULT 'user',
    note TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE embeddings (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vec BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE votes (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE decisions (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    verdict TEXT NOT NULL,
    hide_reason TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    score REAL NOT NULL DEFAULT 0,
    taste REAL,
    hits TEXT NOT NULL DEFAULT '[]',
    incomplete INTEGER NOT NULL DEFAULT 0,
    restored INTEGER NOT NULL DEFAULT 0,
    rules_version INTEGER NOT NULL,
    decided_at TEXT NOT NULL
  );
  CREATE INDEX decisions_verdict ON decisions (verdict);
  `,
  `
  CREATE TABLE judge_log (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    question TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    priority TEXT NOT NULL,
    tier TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX judge_log_kind ON judge_log (kind, id);
  `,
  `
  CREATE TABLE summaries (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('ok', 'skipped', 'failed')),
    text TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0,
    suspicious INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    prompt_version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE stories (
    id INTEGER PRIMARY KEY,
    summary TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    stale INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE story_items (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE
  );
  CREATE INDEX story_items_story ON story_items (story_id);
  CREATE TABLE merge_checked (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );
  CREATE TABLE briefings (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    item_count INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE judge_log ADD COLUMN role TEXT NOT NULL DEFAULT 'acted';
  `,
  `
  ALTER TABLE judge_log ADD COLUMN lane TEXT NOT NULL DEFAULT '';
  CREATE INDEX judge_log_lane ON judge_log (lane, id);
  `,
  `
  ALTER TABLE rules ADD COLUMN promoted_at TEXT;
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY,
    signature TEXT NOT NULL UNIQUE,
    evidence_key TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    condition TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 0,
    rationale TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '[]',
    stats TEXT NOT NULL DEFAULT '{}',
    origin TEXT NOT NULL DEFAULT 'model',
    model TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    rule_id INTEGER,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX proposals_status ON proposals (status, id);
  CREATE INDEX proposals_evidence ON proposals (evidence_key);
  `,
  `
  ALTER TABLE sources ADD COLUMN auth TEXT;
  `,
  `
  CREATE TABLE pipes (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    doc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE pipe_answers (
    question_key TEXT NOT NULL,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    answer INTEGER NOT NULL,
    probability REAL NOT NULL,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (question_key, item_id)
  );
  `,
  `
  CREATE TABLE deliveries (
    briefing_id INTEGER NOT NULL REFERENCES briefings(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    next_attempt_at TEXT,
    delivered_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (briefing_id, channel)
  );
  `,
  `
  CREATE TABLE video_readings (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('ok', 'none', 'failed')),
    rung TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    transcript TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    duration_s REAL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE video_durations (
    video_id TEXT PRIMARY KEY,
    seconds INTEGER NOT NULL,
    source TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );
  `,
];

type Row = Record<string, unknown>;

function toJudgment(row: Row): StoredJudgment {
  return {
    id: Number(row["id"]),
    kind: String(row["kind"]),
    question: String(row["question"]),
    input: JSON.parse(String(row["input"])) as unknown,
    output: JSON.parse(String(row["output"])) as unknown,
    model: String(row["model"]),
    provider: String(row["provider"]),
    priority: String(row["priority"]),
    tier: row["tier"] as DataTier,
    role: String(row["role"]),
    lane: String(row["lane"] ?? ""),
    createdAt: String(row["created_at"]),
  };
}

function toVideoReading(row: Row): StoredVideoReading {
  return {
    itemId: Number(row["item_id"]),
    status: row["status"] as StoredVideoReading["status"],
    rung: String(row["rung"]),
    model: String(row["model"]),
    text: String(row["text"]),
    transcript: String(row["transcript"]),
    note: String(row["note"]),
    attempts: Number(row["attempts"]),
    durationSec: row["duration_s"] === null || row["duration_s"] === undefined ? null : Number(row["duration_s"]),
    createdAt: String(row["created_at"]),
  };
}

function toSource(row: Row): Source {
  return {
    id: Number(row["id"]),
    kind: row["kind"] as SourceKind,
    url: String(row["url"]),
    title: String(row["title"]),
    siteUrl: String(row["site_url"]),
    folder: String(row["folder"]),
    tier: row["tier"] as DataTier,
    etag: (row["etag"] as string | null) ?? null,
    lastModified: (row["last_modified"] as string | null) ?? null,
    lastFetchedAt: (row["last_fetched_at"] as string | null) ?? null,
    nextFetchAt: String(row["next_fetch_at"]),
    errorCount: Number(row["error_count"]),
    lastError: (row["last_error"] as string | null) ?? null,
    pollMinutes: Number(row["poll_minutes"]),
    createdAt: String(row["created_at"]),
    auth: (row["auth"] as Source["auth"]) ?? null,
  };
}

/** One briefing sent (or being sent) to one channel. */
export interface Delivery {
  briefingId: number;
  channel: string;
  status: "sent" | "retry" | "failed";
  attempts: number;
  lastError: string;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
}

export interface StoredPipe {
  id: number;
  slug: string;
  name: string;
  doc: PipeDoc;
  createdAt: string;
  updatedAt: string;
}

function toDelivery(row: Row): Delivery {
  return {
    briefingId: Number(row["briefing_id"]),
    channel: String(row["channel"]),
    status: row["status"] as Delivery["status"],
    attempts: Number(row["attempts"]),
    lastError: String(row["last_error"]),
    nextAttemptAt: row["next_attempt_at"] === null ? null : String(row["next_attempt_at"]),
    deliveredAt: row["delivered_at"] === null ? null : String(row["delivered_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

function toPipe(row: Row): StoredPipe {
  return { id: Number(row["id"]), slug: String(row["slug"]), name: String(row["name"]), doc: JSON.parse(String(row["doc"])) as PipeDoc, createdAt: String(row["created_at"]), updatedAt: String(row["updated_at"]) };
}

function toProposal(row: Row): Proposal {
  return {
    id: Number(row["id"]),
    signature: String(row["signature"]),
    evidenceKey: String(row["evidence_key"]),
    kind: row["kind"] as RuleKind,
    scope: JSON.parse(String(row["scope"])) as RuleScope,
    condition: JSON.parse(String(row["condition"])) as RuleCondition,
    weight: Number(row["weight"]),
    rationale: String(row["rationale"]),
    evidence: JSON.parse(String(row["evidence"])) as number[],
    stats: JSON.parse(String(row["stats"])) as Record<string, unknown>,
    origin: row["origin"] as "code" | "model",
    model: String(row["model"]),
    status: row["status"] as "pending" | "accepted" | "rejected",
    ruleId: row["rule_id"] === null ? null : Number(row["rule_id"]),
    createdAt: String(row["created_at"]),
    decidedAt: row["decided_at"] === null ? null : String(row["decided_at"]),
  };
}

function toRule(row: Row): Rule {
  return {
    id: Number(row["id"]),
    kind: row["kind"] as RuleKind,
    scope: JSON.parse(String(row["scope"])) as RuleScope,
    condition: JSON.parse(String(row["condition"])) as RuleCondition,
    weight: Number(row["weight"]),
    status: row["status"] as RuleStatus,
    origin: row["origin"] as RuleOrigin,
    note: String(row["note"]),
    version: Number(row["version"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
    promotedAt: row["promoted_at"] === null || row["promoted_at"] === undefined ? null : String(row["promoted_at"]),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row)["user_version"]);
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[version] as string);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  addSource(input: { kind: SourceKind; url: string; title?: string; siteUrl?: string; folder?: string; tier?: DataTier; pollMinutes?: number; auth?: Source["auth"] }, now = new Date()): Source {
    const iso = now.toISOString();
    const result = this.db
      .prepare(`INSERT INTO sources (kind, url, title, site_url, folder, tier, poll_minutes, next_fetch_at, created_at, auth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.kind, input.url, input.title ?? "", input.siteUrl ?? "", input.folder ?? "", input.tier ?? "public", input.pollMinutes ?? 30, iso, iso, input.auth ?? null);
    return this.getSource(Number(result.lastInsertRowid)) as Source;
  }

  /** Clears a feed's error count and makes it due now, so a replaced login is tried at the next tick. */
  retrySourceNow(id: number, now = new Date()): void {
    this.db.prepare("UPDATE sources SET next_fetch_at = ?, error_count = 0, last_error = NULL, etag = NULL, last_modified = NULL WHERE id = ?").run(now.toISOString(), id);
  }

  /** Changes a feed's folder, data tier or polling interval. A new interval takes effect from the next fetch; the tier applies to the feed's items at once, since every item reads its feed's tier. */
  updateSource(id: number, patch: { folder?: string; tier?: DataTier; pollMinutes?: number }): Source | undefined {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (patch.folder !== undefined) {
      sets.push("folder = ?");
      values.push(patch.folder);
    }
    if (patch.tier !== undefined) {
      sets.push("tier = ?");
      values.push(patch.tier);
    }
    if (patch.pollMinutes !== undefined) {
      sets.push("poll_minutes = ?");
      values.push(patch.pollMinutes);
    }
    if (sets.length) this.db.prepare(`UPDATE sources SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return this.getSource(id);
  }

  /** Records which kind of login a feed uses (never the login itself); null clears it. */
  setSourceAuth(id: number, auth: Source["auth"]): void {
    this.db.prepare("UPDATE sources SET auth = ? WHERE id = ?").run(auth, id);
  }

  getSource(id: number): Source | undefined {
    const row = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Row | undefined;
    return row ? toSource(row) : undefined;
  }

  findSourceByUrl(url: string): Source | undefined {
    const row = this.db.prepare("SELECT * FROM sources WHERE url = ?").get(url) as Row | undefined;
    return row ? toSource(row) : undefined;
  }

  listSources(): Source[] {
    return (this.db.prepare("SELECT * FROM sources ORDER BY folder, title COLLATE NOCASE, id").all() as Row[]).map(toSource);
  }

  dueSources(now: Date): Source[] {
    return (this.db.prepare("SELECT * FROM sources WHERE next_fetch_at <= ? ORDER BY next_fetch_at, id").all(now.toISOString()) as Row[]).map(toSource);
  }

  removeSource(id: number): boolean {
    return this.db.prepare("DELETE FROM sources WHERE id = ?").run(id).changes > 0;
  }

  recordPoll(id: number, update: { title?: string; siteUrl?: string; etag: string | null; lastModified: string | null; nextFetchAt: Date; error: string | null; now: Date }): void {
    const failed = update.error !== null;
    this.db
      .prepare(
        `UPDATE sources SET
           title = CASE WHEN ? != '' THEN ? ELSE title END,
           site_url = CASE WHEN ? != '' THEN ? ELSE site_url END,
           etag = ?, last_modified = ?, last_fetched_at = ?, next_fetch_at = ?,
           error_count = CASE WHEN ? THEN error_count + 1 ELSE 0 END,
           last_error = ?
         WHERE id = ?`,
      )
      .run(update.title ?? "", update.title ?? "", update.siteUrl ?? "", update.siteUrl ?? "", update.etag, update.lastModified, update.now.toISOString(), update.nextFetchAt.toISOString(), failed ? 1 : 0, update.error, id);
  }

  /** Inserts items that are new for the source; returns how many were inserted. */
  upsertItems(sourceId: number, items: NewItem[], now = new Date()): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO items (source_id, guid, url, title, author, published_at, fetched_at, summary_text, content_html, image, title_hash, extra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    this.db.exec("BEGIN");
    try {
      for (const it of items) {
        const result = insert.run(sourceId, it.guid, it.url, it.title, it.author, it.publishedAt, now.toISOString(), it.summaryText, it.contentHtml, it.image, it.titleHash, JSON.stringify(it.extra));
        inserted += Number(result.changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return inserted;
  }

  listItems(query: ItemQuery = {}): Item[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.sourceId !== undefined) {
      where.push("i.source_id = ?");
      params.push(query.sourceId);
    }
    if (query.sourceIds) {
      if (!query.sourceIds.length) return [];
      where.push(`i.source_id IN (${query.sourceIds.map(() => "?").join(",")})`);
      params.push(...query.sourceIds);
    }
    if (query.unreadOnly) where.push("i.is_read = 0");
    if (query.itemId !== undefined) {
      where.push("i.id = ?");
      params.push(query.itemId);
    }
    if (query.beforeId !== undefined) {
      // A keyset cursor on the same key the list is sorted by, so paging from the last item of a page walks every item once.
      where.push("(COALESCE(i.published_at, i.fetched_at), i.id) < (SELECT COALESCE(c.published_at, c.fetched_at), c.id FROM items c WHERE c.id = ?)");
      params.push(query.beforeId);
    }
    const view = query.view ?? "all";
    if (view === "inbox") where.push("(d.item_id IS NULL OR d.verdict = 'show' OR d.restored = 1)");
    if (view === "filtered") where.push("(d.verdict = 'hide' AND d.restored = 0)");
    const limit = Math.min(Math.max(query.limit ?? 50, 1), query.wide ? 2000 : 200);
    const rows = this.db
      .prepare(
        `SELECT i.id, i.source_id, s.title AS source_title, i.guid, i.url, i.title, i.author, i.published_at, i.fetched_at, i.summary_text, i.image, i.title_hash, i.extra, i.is_read,
                v.vote AS vote, v.reason AS vote_reason,
                sm.text AS sm_text, sm.evidence AS sm_evidence, sm.verified AS sm_verified, sm.suspicious AS sm_suspicious, sm.model AS sm_model,
                vr.text AS vr_text, vr.rung AS vr_rung,
                d.verdict AS d_verdict, d.hide_reason AS d_hide_reason, d.pinned AS d_pinned, d.score AS d_score, d.taste AS d_taste, d.hits AS d_hits, d.incomplete AS d_incomplete, d.restored AS d_restored
         FROM items i JOIN sources s ON s.id = i.source_id
         LEFT JOIN votes v ON v.item_id = i.id
         LEFT JOIN decisions d ON d.item_id = i.id
         LEFT JOIN summaries sm ON sm.item_id = i.id AND sm.status = 'ok'
         LEFT JOIN video_readings vr ON vr.item_id = i.id AND vr.status = 'ok'
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.id DESC LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      sourceId: Number(r["source_id"]),
      sourceTitle: String(r["source_title"]),
      guid: String(r["guid"]),
      url: String(r["url"]),
      title: String(r["title"]),
      author: String(r["author"]),
      publishedAt: (r["published_at"] as string | null) ?? null,
      fetchedAt: String(r["fetched_at"]),
      summaryText: String(r["summary_text"]),
      image: String(r["image"]),
      titleHash: String(r["title_hash"]),
      extra: JSON.parse(String(r["extra"])) as Record<string, string>,
      read: Number(r["is_read"]) === 1,
      vote: r["vote"] === null || r["vote"] === undefined ? 0 : Number(r["vote"]),
      voteReason: r["vote_reason"] === null || r["vote_reason"] === undefined ? "" : String(r["vote_reason"]),
      summary:
        r["sm_text"] === null || r["sm_text"] === undefined
          ? null
          : { text: String(r["sm_text"]), evidence: String(r["sm_evidence"]), verified: Number(r["sm_verified"]) === 1, suspicious: Number(r["sm_suspicious"]) === 1, model: String(r["sm_model"]) },
      video: r["vr_text"] === null || r["vr_text"] === undefined ? null : { text: String(r["vr_text"]), rung: String(r["vr_rung"]) },
      decision:
        r["d_verdict"] === null || r["d_verdict"] === undefined
          ? null
          : {
              verdict: r["d_verdict"] as "show" | "hide",
              hideReason: (r["d_hide_reason"] as "block" | "soft" | null) ?? null,
              pinned: Number(r["d_pinned"]) === 1,
              score: Number(r["d_score"]),
              taste: r["d_taste"] === null ? null : Number(r["d_taste"]),
              hits: JSON.parse(String(r["d_hits"])) as RuleHit[],
              incomplete: Number(r["d_incomplete"]) === 1,
              restored: Number(r["d_restored"]) === 1,
            },
    }));
  }

  setRead(id: number, read: boolean): boolean {
    return this.db.prepare("UPDATE items SET is_read = ? WHERE id = ?").run(read ? 1 : 0, id).changes > 0;
  }

  // ---- rules ----

  rulesVersion(): number {
    return Number((this.db.prepare("SELECT value FROM meta WHERE key = 'rules_version'").get() as Row)["value"]);
  }

  private bumpRulesVersion(): void {
    this.db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rules_version'").run();
  }

  addRule(input: NewRule, now = new Date()): Rule {
    const iso = now.toISOString();
    const result = this.db
      .prepare(`INSERT INTO rules (kind, scope, condition, weight, status, origin, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.kind, JSON.stringify(input.scope), JSON.stringify(input.condition), input.weight ?? 0, input.status ?? "active", input.origin ?? "user", input.note ?? "", iso, iso);
    this.bumpRulesVersion();
    return this.getRule(Number(result.lastInsertRowid)) as Rule;
  }

  getRule(id: number): Rule | undefined {
    const row = this.db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as Row | undefined;
    return row ? toRule(row) : undefined;
  }

  /** How many stored decisions each rule is a hit in, split into rules that acted and rules only watching (shadow). */
  ruleMatchCounts(): Map<number, { acting: number; shadow: number }> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(h.value, '$.ruleId') AS rule_id,
                SUM(CASE WHEN json_extract(h.value, '$.shadow') = 0 THEN 1 ELSE 0 END) AS acting,
                SUM(CASE WHEN json_extract(h.value, '$.shadow') = 1 THEN 1 ELSE 0 END) AS shadow
         FROM decisions d, json_each(d.hits) h GROUP BY rule_id`,
      )
      .all() as Row[];
    return new Map(rows.map((r) => [Number(r["rule_id"]), { acting: Number(r["acting"]), shadow: Number(r["shadow"]) }]));
  }

  listRules(): Rule[] {
    return (this.db.prepare("SELECT * FROM rules ORDER BY id").all() as Row[]).map(toRule);
  }

  updateRule(id: number, patch: Partial<NewRule>, now = new Date()): Rule | undefined {
    const current = this.getRule(id);
    if (!current) return undefined;
    const next = {
      kind: patch.kind ?? current.kind,
      scope: patch.scope ?? current.scope,
      condition: patch.condition ?? current.condition,
      weight: patch.weight ?? current.weight,
      status: patch.status ?? current.status,
      note: patch.note ?? current.note,
    };
    this.db
      .prepare("UPDATE rules SET kind = ?, scope = ?, condition = ?, weight = ?, status = ?, note = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(next.kind, JSON.stringify(next.scope), JSON.stringify(next.condition), next.weight, next.status, next.note, now.toISOString(), id);
    this.bumpRulesVersion();
    return this.getRule(id);
  }

  /** Marks a learned rule as having passed its bar (or been promoted by hand): it acts from now on, with an audit pass-through. */
  promoteRule(id: number, now = new Date()): Rule | undefined {
    if (!this.getRule(id)) return undefined;
    this.db.prepare("UPDATE rules SET status = 'active', promoted_at = ?, version = version + 1, updated_at = ? WHERE id = ?").run(now.toISOString(), now.toISOString(), id);
    this.bumpRulesVersion();
    return this.getRule(id);
  }

  /** Every vote on an item a rule currently matches, with when it was cast, grouped by rule. */
  votesByRule(): Map<number, { vote: number; votedAt: string }[]> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(h.value, '$.ruleId') AS rule_id, v.vote AS vote, v.created_at AS voted_at
         FROM decisions d, json_each(d.hits) h JOIN votes v ON v.item_id = d.item_id`,
      )
      .all() as Row[];
    const out = new Map<number, { vote: number; votedAt: string }[]>();
    for (const r of rows) {
      const id = Number(r["rule_id"]);
      const list = out.get(id) ?? [];
      list.push({ vote: Number(r["vote"]), votedAt: String(r["voted_at"]) });
      out.set(id, list);
    }
    return out;
  }

  /** How many items have a stored decision, for judging how wide a rule's reach is. */
  decidedCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as Row)["n"]);
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row["value"]) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---- deliveries ----

  getDelivery(briefingId: number, channel: string): Delivery | undefined {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE briefing_id = ? AND channel = ?").get(briefingId, channel) as Row | undefined;
    return row ? toDelivery(row) : undefined;
  }

  saveDelivery(d: Omit<Delivery, "updatedAt">, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO deliveries (briefing_id, channel, status, attempts, last_error, next_attempt_at, delivered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(briefing_id, channel) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at, delivered_at = excluded.delivered_at, updated_at = excluded.updated_at`,
      )
      .run(d.briefingId, d.channel, d.status, d.attempts, d.lastError, d.nextAttemptAt, d.deliveredAt, now.toISOString());
  }

  /** The newest deliveries first, for the Connect screen. */
  listDeliveries(limit = 20): Delivery[] {
    return (this.db.prepare("SELECT * FROM deliveries ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map(toDelivery);
  }

  /** The data tier of each item's feed. An id with no item is left out. */
  itemTiers(ids: number[]): Map<number, DataTier> {
    const out = new Map<number, DataTier>();
    const stmt = this.db.prepare("SELECT s.tier FROM items i JOIN sources s ON s.id = i.source_id WHERE i.id = ?");
    for (const id of ids) {
      const row = stmt.get(id) as Row | undefined;
      if (row) out.set(id, row["tier"] as DataTier);
    }
    return out;
  }

  // ---- proposals ----

  addProposal(input: NewProposal, now = new Date()): Proposal | undefined {
    const result = this.db
      .prepare(
        `INSERT INTO proposals (signature, evidence_key, kind, scope, condition, weight, rationale, evidence, stats, origin, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(signature) DO NOTHING`,
      )
      .run(input.signature, input.evidenceKey, input.kind, JSON.stringify(input.scope), JSON.stringify(input.condition), input.weight, input.rationale, JSON.stringify(input.evidence), JSON.stringify(input.stats), input.origin, input.model, now.toISOString());
    return result.changes ? this.getProposal(Number(result.lastInsertRowid)) : undefined;
  }

  getProposal(id: number): Proposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    return row ? toProposal(row) : undefined;
  }

  listProposals(status: "pending" | "accepted" | "rejected" = "pending"): Proposal[] {
    return (this.db.prepare("SELECT * FROM proposals WHERE status = ? ORDER BY id DESC").all(status) as Row[]).map(toProposal);
  }

  /** True when this evidence set was already drafted from, whatever came of it, so the same votes never cost a second model call. */
  evidenceDrafted(evidenceKey: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM proposals WHERE evidence_key = ?").get(evidenceKey);
  }

  decideProposal(id: number, status: "accepted" | "rejected", ruleId: number | null, now = new Date()): boolean {
    return this.db.prepare("UPDATE proposals SET status = ?, rule_id = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, ruleId, now.toISOString(), id).changes > 0;
  }

  /** Voted items with what a proposer needs to cluster them and to draft a rule: the vote, the user's reason, and the item text. */
  votedItems(limit = 600): VotedItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.source_id, s.folder, s.tier, s.title AS source_title, i.url, i.title, i.author, i.summary_text, v.vote, v.reason, v.created_at AS voted_at
         FROM votes v JOIN items i ON i.id = v.item_id JOIN sources s ON s.id = i.source_id ORDER BY v.created_at DESC, i.id DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      sourceId: Number(r["source_id"]),
      sourceTitle: String(r["source_title"]),
      folder: String(r["folder"]),
      tier: r["tier"] as DataTier,
      url: String(r["url"]),
      title: String(r["title"]),
      author: String(r["author"]),
      text: String(r["summary_text"]),
      vote: Number(r["vote"]),
      reason: String(r["reason"]),
      votedAt: String(r["voted_at"]),
    }));
  }

  /** Unvoted items from the last window with a vector for the model: the pool the active-learning ask draws from. */
  askCandidates(model: string, sinceIso: string, limit = 400): { id: number; vec: Float32Array }[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, e.vec FROM items i JOIN embeddings e ON e.item_id = i.id AND e.model = ?
         LEFT JOIN votes v ON v.item_id = i.id LEFT JOIN decisions d ON d.item_id = i.id
         WHERE v.item_id IS NULL AND (d.item_id IS NULL OR d.verdict = 'show' OR d.restored = 1) AND COALESCE(i.published_at, i.fetched_at) >= ?
         ORDER BY i.id DESC LIMIT ?`,
      )
      .all(model, sinceIso, limit) as Row[];
    return rows.map((r) => ({ id: Number(r["id"]), vec: fromBlob(r["vec"] as Uint8Array) }));
  }

  removeRule(id: number): boolean {
    const removed = this.db.prepare("DELETE FROM rules WHERE id = ?").run(id).changes > 0;
    if (removed) this.bumpRulesVersion();
    return removed;
  }

  // ---- summaries ----

  /** Shown items that have no summary yet (or a failed one with attempts left), newest first because fresh items matter most. */
  itemsNeedingSummary(limit: number, waitForVideo = false): PendingItem[] {
    // A video item waits for its reading (or for the reader to give up) so its summary can use what the video says.
    const hold = waitForVideo
      ? ` AND NOT (${VIDEO_URL} AND NOT EXISTS (SELECT 1 FROM video_readings vr WHERE vr.item_id = i.id AND (vr.status IN ('ok', 'none') OR vr.attempts >= ?)))`
      : "";
    return this.pending(
      `EXISTS (SELECT 1 FROM decisions d WHERE d.item_id = i.id AND (d.verdict = 'show' OR d.restored = 1))
       AND NOT EXISTS (SELECT 1 FROM summaries sm WHERE sm.item_id = i.id AND (sm.status IN ('ok', 'skipped') OR sm.attempts >= ?))${hold}`,
      waitForVideo ? [MAX_SUMMARY_ATTEMPTS, MAX_VIDEO_ATTEMPTS] : [MAX_SUMMARY_ATTEMPTS],
      limit,
      "i.id DESC",
    );
  }

  // ---- video readings ----

  /** Shown video items that have no reading yet, or a failed one that is due another try, newest first. */
  itemsNeedingVideo(limit: number, now = new Date()): PendingItem[] {
    const due = new Date(now.getTime() - VIDEO_RETRY_MS).toISOString();
    return this.pending(
      `EXISTS (SELECT 1 FROM decisions d WHERE d.item_id = i.id AND (d.verdict = 'show' OR d.restored = 1))
       AND ${VIDEO_URL}
       AND NOT EXISTS (SELECT 1 FROM video_readings vr WHERE vr.item_id = i.id AND (vr.status IN ('ok', 'none') OR vr.attempts >= ? OR vr.created_at > ?))`,
      [MAX_VIDEO_ATTEMPTS, due],
      limit,
      "i.id DESC",
    );
  }

  /** Stores a reading, or counts a failed attempt; a failed row keeps its earlier attempts. */
  saveVideoReading(itemId: number, write: VideoReadingWrite, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO video_readings (item_id, status, rung, model, text, transcript, note, attempts, duration_s, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, rung = excluded.rung, model = excluded.model, text = excluded.text, transcript = excluded.transcript,
           note = excluded.note, attempts = video_readings.attempts + excluded.attempts, duration_s = excluded.duration_s, created_at = excluded.created_at`,
      )
      .run(itemId, write.status, write.rung ?? "", write.model ?? "", write.text ?? "", write.transcript ?? "", write.note ?? "", write.status === "failed" ? 1 : 0, write.durationSec ?? null, now.toISOString());
  }

  getVideoReading(itemId: number): StoredVideoReading | undefined {
    const row = this.db.prepare("SELECT * FROM video_readings WHERE item_id = ?").get(itemId) as Row | undefined;
    return row ? toVideoReading(row) : undefined;
  }

  /** What the reader has done: counts by status and rung, and the newest few readings. */
  videoSummary(recent = 8): { counts: { status: string; rung: string; count: number }[]; waiting: number; recent: (StoredVideoReading & { title: string; url: string })[] } {
    const counts = (this.db.prepare("SELECT status, rung, COUNT(*) AS n FROM video_readings GROUP BY status, rung ORDER BY status, rung").all() as Row[]).map((r) => ({ status: String(r["status"]), rung: String(r["rung"]), count: Number(r["n"]) }));
    const waiting = this.itemsNeedingVideo(1000, new Date(4_200_000_000_000)).length;
    const rows = this.db
      .prepare("SELECT vr.*, i.title, i.url FROM video_readings vr JOIN items i ON i.id = vr.item_id ORDER BY vr.created_at DESC LIMIT ?")
      .all(Math.min(Math.max(recent, 1), 50)) as Row[];
    return { counts, waiting, recent: rows.map((r) => ({ ...toVideoReading(r), title: String(r["title"]), url: String(r["url"]) })) };
  }

  /** Stores a summary, or counts a failed attempt; a failed row keeps any earlier attempts. */
  saveSummary(itemId: number, write: SummaryWrite, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO summaries (item_id, status, text, evidence, verified, suspicious, attempts, model, prompt_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, text = excluded.text, evidence = excluded.evidence, verified = excluded.verified,
           suspicious = excluded.suspicious, attempts = summaries.attempts + excluded.attempts, model = excluded.model, prompt_version = excluded.prompt_version, created_at = excluded.created_at`,
      )
      .run(itemId, write.status, write.text ?? "", write.evidence ?? "", write.verified ? 1 : 0, write.suspicious ? 1 : 0, write.status === "failed" ? 1 : 0, write.model ?? "", write.promptVersion, now.toISOString());
  }

  getItem(id: number): PendingItem | undefined {
    return this.pending("i.id = ?", [id], 1)[0];
  }

  // ---- stories ----

  /** Shown items with a vector for the model, published inside the window, with the story each belongs to. */
  mergePool(model: string, sinceMs: number): MergeItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.source_id, s.tier, i.title, COALESCE(i.published_at, i.fetched_at) AS at, e.vec, si.story_id
         FROM items i JOIN sources s ON s.id = i.source_id
         JOIN embeddings e ON e.item_id = i.id AND e.model = ?
         JOIN decisions d ON d.item_id = i.id AND (d.verdict = 'show' OR d.restored = 1)
         LEFT JOIN story_items si ON si.item_id = i.id
         WHERE COALESCE(i.published_at, i.fetched_at) >= ? ORDER BY i.id`,
      )
      .all(model, new Date(sinceMs).toISOString()) as Row[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      sourceId: Number(r["source_id"]),
      tier: r["tier"] as DataTier,
      title: String(r["title"]),
      whenMs: Date.parse(String(r["at"])),
      vector: fromBlob(r["vec"] as Uint8Array),
      storyId: r["story_id"] === null ? null : Number(r["story_id"]),
    }));
  }

  /** Ids already checked for a merge under this model. */
  mergeCheckedIds(model: string): Set<number> {
    return new Set((this.db.prepare("SELECT item_id FROM merge_checked WHERE model = ?").all(model) as Row[]).map((r) => Number(r["item_id"])));
  }

  markMergeChecked(itemId: number, model: string, now = new Date()): void {
    this.db.prepare("INSERT OR REPLACE INTO merge_checked (item_id, model, checked_at) VALUES (?, ?, ?)").run(itemId, model, now.toISOString());
  }

  createStory(itemIds: number[], now = new Date()): number {
    const at = now.toISOString();
    const id = Number(this.db.prepare("INSERT INTO stories (created_at, updated_at) VALUES (?, ?)").run(at, at).lastInsertRowid);
    for (const itemId of itemIds) this.db.prepare("INSERT OR REPLACE INTO story_items (item_id, story_id) VALUES (?, ?)").run(itemId, id);
    return id;
  }

  /** Adds an item to a story and marks the story summary stale so it is rewritten with the new member. */
  addToStory(storyId: number, itemId: number, now = new Date()): void {
    this.db.prepare("INSERT OR REPLACE INTO story_items (item_id, story_id) VALUES (?, ?)").run(itemId, storyId);
    this.db.prepare("UPDATE stories SET stale = 1, attempts = 0, updated_at = ? WHERE id = ?").run(now.toISOString(), storyId);
  }

  staleStoryIds(limit: number): number[] {
    return (this.db.prepare("SELECT id FROM stories WHERE stale = 1 AND attempts < ? ORDER BY id LIMIT ?").all(MAX_SUMMARY_ATTEMPTS, limit) as Row[]).map((r) => Number(r["id"]));
  }

  storyMembers(storyId: number): StoryMember[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, s.title AS source_title, s.tier, i.url, i.title, i.summary_text FROM story_items si
         JOIN items i ON i.id = si.item_id JOIN sources s ON s.id = i.source_id WHERE si.story_id = ? ORDER BY COALESCE(i.published_at, i.fetched_at), i.id`,
      )
      .all(storyId) as Row[];
    return rows.map((r) => ({ itemId: Number(r["id"]), sourceTitle: String(r["source_title"]), url: String(r["url"]), title: String(r["title"]), text: String(r["summary_text"]), tier: r["tier"] as DataTier }));
  }

  saveStorySummary(storyId: number, summary: { text: string; evidence: string; verified: boolean; model: string }, now = new Date()): void {
    this.db.prepare("UPDATE stories SET summary = ?, evidence = ?, verified = ?, model = ?, stale = 0, updated_at = ? WHERE id = ?").run(summary.text, summary.evidence, summary.verified ? 1 : 0, summary.model, now.toISOString(), storyId);
  }

  failStorySummary(storyId: number): void {
    this.db.prepare("UPDATE stories SET attempts = attempts + 1 WHERE id = ?").run(storyId);
  }

  getStory(storyId: number): StoredStory | undefined {
    const r = this.db.prepare("SELECT * FROM stories WHERE id = ?").get(storyId) as Row | undefined;
    return r ? { id: Number(r["id"]), summary: String(r["summary"]), evidence: String(r["evidence"]), verified: Number(r["verified"]) === 1, model: String(r["model"]) } : undefined;
  }

  // ---- briefings ----

  /** Unread shown items published in the window, minus anything the user voted down, with the data a briefing entry needs. */
  briefingItems(sinceMs: number, untilMs: number): BriefingItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, s.folder, s.title AS source_title, i.url, i.title, COALESCE(i.published_at, i.fetched_at) AS at,
                sm.text AS sm_text, sm.evidence AS sm_evidence, sm.verified AS sm_verified, sm.suspicious AS sm_suspicious, sm.model AS sm_model,
                d.pinned AS d_pinned, d.taste AS d_taste, si.story_id
         FROM items i JOIN sources s ON s.id = i.source_id
         JOIN decisions d ON d.item_id = i.id AND (d.verdict = 'show' OR d.restored = 1)
         LEFT JOIN summaries sm ON sm.item_id = i.id AND sm.status = 'ok'
         LEFT JOIN story_items si ON si.item_id = i.id
         LEFT JOIN votes v ON v.item_id = i.id
         WHERE i.is_read = 0 AND COALESCE(v.vote, 0) >= 0 AND COALESCE(i.published_at, i.fetched_at) >= ? AND COALESCE(i.published_at, i.fetched_at) <= ?
         ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.id DESC`,
      )
      .all(new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()) as Row[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      folder: String(r["folder"]),
      sourceTitle: String(r["source_title"]),
      url: String(r["url"]),
      title: String(r["title"]),
      whenMs: Date.parse(String(r["at"])),
      summary:
        r["sm_text"] === null || r["sm_text"] === undefined
          ? null
          : { text: String(r["sm_text"]), evidence: String(r["sm_evidence"]), verified: Number(r["sm_verified"]) === 1, suspicious: Number(r["sm_suspicious"]) === 1, model: String(r["sm_model"]) },
      pinned: Number(r["d_pinned"]) === 1,
      taste: r["d_taste"] === null ? null : Number(r["d_taste"]),
      storyId: r["story_id"] === null ? null : Number(r["story_id"]),
    }));
  }

  saveBriefing(b: { kind: string; periodStart: string; periodEnd: string; itemCount: number; body: string }, now = new Date()): number {
    return Number(this.db.prepare("INSERT INTO briefings (kind, period_start, period_end, item_count, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(b.kind, b.periodStart, b.periodEnd, b.itemCount, b.body, now.toISOString()).lastInsertRowid);
  }

  private toBriefing(r: Row): StoredBriefing {
    return { id: Number(r["id"]), kind: String(r["kind"]), periodStart: String(r["period_start"]), periodEnd: String(r["period_end"]), itemCount: Number(r["item_count"]), body: String(r["body"]), createdAt: String(r["created_at"]) };
  }

  getBriefing(id: number): StoredBriefing | undefined {
    const r = this.db.prepare("SELECT * FROM briefings WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toBriefing(r) : undefined;
  }

  listBriefings(limit = 20): Omit<StoredBriefing, "body">[] {
    return (this.db.prepare("SELECT * FROM briefings ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => {
      const { body: _body, ...rest } = this.toBriefing(r);
      return rest;
    });
  }

  /** Marks every unread item read, for the explicit catch-up action after an import. Returns how many changed. */
  markAllRead(): number {
    return Number(this.db.prepare("UPDATE items SET is_read = 1 WHERE is_read = 0").run().changes);
  }

  /** Marks every listed item read, for the explicit "mark this briefing read" action. */
  markItemsRead(ids: number[]): number {
    let changed = 0;
    for (const id of ids) changed += Number(this.db.prepare("UPDATE items SET is_read = 1 WHERE id = ? AND is_read = 0").run(id).changes);
    return changed;
  }

  // ---- judge log ----

  /** Every judgment is kept as a labelled example for later training of a local judge. */
  logJudgment(entry: JudgmentEntry, now = new Date()): number {
    const result = this.db
      .prepare("INSERT INTO judge_log (kind, question, input, output, model, provider, priority, tier, role, lane, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(entry.kind, entry.question, JSON.stringify(entry.input), JSON.stringify(entry.output), entry.model, entry.provider, entry.priority, entry.tier, entry.role ?? "acted", entry.lane ?? "", now.toISOString());
    return Number(result.lastInsertRowid);
  }

  recentJudgments(limit = 50): StoredJudgment[] {
    return (this.db.prepare("SELECT * FROM judge_log ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toJudgment);
  }

  /** Every logged judgment that belongs to a lane, oldest first, for building training rows. */
  laneJudgments(lanes: string[], limit = 100_000): StoredJudgment[] {
    if (!lanes.length) return [];
    return (this.db.prepare(`SELECT * FROM judge_log WHERE lane IN (${lanes.map(() => "?").join(",")}) ORDER BY id ASC LIMIT ?`).all(...lanes, limit) as Row[]).map(toJudgment);
  }

  /** A random id for this install, made once, so exported training rows from different installs never share an id. */
  installId(): string {
    let id = this.getMeta("install:id");
    if (!id) {
      id = randomBytes(6).toString("hex");
      this.setMeta("install:id", id);
    }
    return id;
  }

  /** Counts of logged judgments by lane, role and provider, for the training status. */
  laneCounts(): { lane: string; role: string; provider: string; kind: string; count: number }[] {
    return (this.db.prepare("SELECT lane, role, provider, kind, COUNT(*) AS n FROM judge_log WHERE lane != '' GROUP BY lane, role, provider, kind").all() as Row[]).map((r) => ({ lane: String(r["lane"]), role: String(r["role"]), provider: String(r["provider"]), kind: String(r["kind"]), count: Number(r["n"]) }));
  }

  // ---- pipes ----

  addPipe(input: { slug: string; name: string; doc: PipeDoc }, now = new Date()): StoredPipe {
    const when = now.toISOString();
    const info = this.db.prepare("INSERT INTO pipes (slug, name, doc, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(input.slug, input.name, JSON.stringify(input.doc), when, when);
    return this.getPipe(Number(info.lastInsertRowid)) as StoredPipe;
  }

  getPipe(id: number): StoredPipe | undefined {
    const row = this.db.prepare("SELECT * FROM pipes WHERE id = ?").get(id) as Row | undefined;
    return row ? toPipe(row) : undefined;
  }

  getPipeBySlug(slug: string): StoredPipe | undefined {
    const row = this.db.prepare("SELECT * FROM pipes WHERE slug = ?").get(slug) as Row | undefined;
    return row ? toPipe(row) : undefined;
  }

  listPipes(): StoredPipe[] {
    return (this.db.prepare("SELECT * FROM pipes ORDER BY name COLLATE NOCASE, id").all() as Row[]).map(toPipe);
  }

  updatePipe(id: number, patch: { name?: string; doc?: PipeDoc }, now = new Date()): StoredPipe | undefined {
    const current = this.getPipe(id);
    if (!current) return undefined;
    this.db.prepare("UPDATE pipes SET name = ?, doc = ?, updated_at = ? WHERE id = ?").run(patch.name ?? current.name, JSON.stringify(patch.doc ?? current.doc), now.toISOString(), id);
    return this.getPipe(id);
  }

  removePipe(id: number): boolean {
    return this.db.prepare("DELETE FROM pipes WHERE id = ?").run(id).changes > 0;
  }

  /** The AI's stored answers to one pipe question for these items. */
  pipeAnswers(questionKey: string, itemIds: number[]): Map<number, { answer: boolean; probability: number }> {
    const out = new Map<number, { answer: boolean; probability: number }>();
    const stmt = this.db.prepare("SELECT answer, probability FROM pipe_answers WHERE question_key = ? AND item_id = ?");
    for (const id of itemIds) {
      const row = stmt.get(questionKey, id) as Row | undefined;
      if (row) out.set(id, { answer: Number(row["answer"]) === 1, probability: Number(row["probability"]) });
    }
    return out;
  }

  savePipeAnswer(questionKey: string, itemId: number, answer: { answer: boolean; probability: number; model: string }, now = new Date()): void {
    this.db
      .prepare("INSERT INTO pipe_answers (question_key, item_id, answer, probability, model, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(question_key, item_id) DO UPDATE SET answer = excluded.answer, probability = excluded.probability, model = excluded.model, created_at = excluded.created_at")
      .run(questionKey, itemId, answer.answer ? 1 : 0, answer.probability, answer.model, now.toISOString());
  }

  // ---- embeddings ----

  /** Items that have no stored embedding for the model yet, oldest first so a backlog drains in order. */
  itemsNeedingEmbedding(model: string, limit: number): PendingItem[] {
    return this.pending(`NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.item_id = i.id AND e.model = ?)`, [model], limit);
  }

  private pending(condition: string, params: (string | number)[], limit: number, order = "i.id"): PendingItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.source_id, i.url, s.folder, s.tier, i.title, i.author, i.summary_text
         FROM items i JOIN sources s ON s.id = i.source_id
         WHERE ${condition} ORDER BY ${order} LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r["id"]),
      sourceId: Number(r["source_id"]),
      url: String(r["url"]),
      folder: String(r["folder"]),
      tier: r["tier"] as DataTier,
      title: String(r["title"]),
      author: String(r["author"]),
      text: String(r["summary_text"]),
    }));
  }

  // ---- video lengths ----

  /** The stored length in seconds of each video id that has one; a negative length means the video had none to give. */
  getVideoDurations(ids: string[]): Map<string, number> {
    const out = new Map<string, number>();
    const get = this.db.prepare("SELECT seconds FROM video_durations WHERE video_id = ?");
    for (const id of new Set(ids)) {
      const row = get.get(id) as Row | undefined;
      if (row) out.set(id, Number(row["seconds"]));
    }
    return out;
  }

  saveVideoDuration(videoId: string, seconds: number, source: string, now = new Date()): void {
    this.db
      .prepare("INSERT INTO video_durations (video_id, seconds, source, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET seconds = excluded.seconds, source = excluded.source, checked_at = excluded.checked_at")
      .run(videoId, Math.round(seconds), source, now.toISOString());
  }

  /** The newest items with their rule-relevant text, for previewing a draft rule. */
  recentItemsForPreview(limit: number): PendingItem[] {
    return this.pending("1 = 1", [], Math.min(Math.max(limit, 1), 1000), "i.id DESC");
  }

  saveEmbedding(itemId: number, model: string, vector: Float32Array, now = new Date()): void {
    this.db
      .prepare("INSERT INTO embeddings (item_id, model, dims, vec, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vec = excluded.vec, created_at = excluded.created_at")
      .run(itemId, model, vector.length, toBlob(vector), now.toISOString());
  }

  getEmbedding(itemId: number, model: string): Float32Array | undefined {
    const row = this.db.prepare("SELECT vec FROM embeddings WHERE item_id = ? AND model = ?").get(itemId, model) as Row | undefined;
    return row ? fromBlob(row["vec"] as Uint8Array) : undefined;
  }

  /** Vectors of voted items for the model, split by vote. */
  votedVectors(model: string): { liked: Float32Array[]; disliked: Float32Array[] } {
    const rows = this.db.prepare("SELECT v.vote, e.vec FROM votes v JOIN embeddings e ON e.item_id = v.item_id AND e.model = ? ORDER BY v.item_id").all(model) as Row[];
    const liked: Float32Array[] = [];
    const disliked: Float32Array[] = [];
    for (const r of rows) (Number(r["vote"]) > 0 ? liked : disliked).push(fromBlob(r["vec"] as Uint8Array));
    return { liked, disliked };
  }

  // ---- votes ----

  /** Records a vote (1 or -1) with an optional reason, or clears it with 0. */
  setVote(itemId: number, vote: number, reason = "", now = new Date()): boolean {
    if (!this.db.prepare("SELECT 1 FROM items WHERE id = ?").get(itemId)) return false;
    if (vote === 0) this.db.prepare("DELETE FROM votes WHERE item_id = ?").run(itemId);
    else
      this.db
        .prepare("INSERT INTO votes (item_id, vote, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET vote = excluded.vote, reason = excluded.reason, created_at = excluded.created_at")
        .run(itemId, vote > 0 ? 1 : -1, reason.slice(0, 500), now.toISOString());
    return true;
  }

  // ---- decisions ----

  /** Items with no decision for the current rules, or whose decision was incomplete (a semantic rule had no embedding). */
  itemsNeedingDecision(limit: number): PendingItem[] {
    return this.pending(`NOT EXISTS (SELECT 1 FROM decisions d WHERE d.item_id = i.id AND d.rules_version = ? AND d.incomplete = 0)`, [this.rulesVersion()], limit);
  }

  saveDecision(itemId: number, decision: { verdict: "show" | "hide"; hideReason: "block" | "soft" | null; pinned: boolean; score: number; taste: number | null; hits: RuleHit[]; incomplete: boolean }, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO decisions (item_id, verdict, hide_reason, pinned, score, taste, hits, incomplete, rules_version, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET verdict = excluded.verdict, hide_reason = excluded.hide_reason, pinned = excluded.pinned, score = excluded.score, taste = excluded.taste,
           hits = excluded.hits, incomplete = excluded.incomplete, rules_version = excluded.rules_version, decided_at = excluded.decided_at`,
      )
      .run(itemId, decision.verdict, decision.hideReason, decision.pinned ? 1 : 0, decision.score, decision.taste, JSON.stringify(decision.hits), decision.incomplete ? 1 : 0, this.rulesVersion(), now.toISOString());
  }

  /** One-click restore: the item shows in the inbox from now on, even if a rule still matches. */
  restoreItem(itemId: number): boolean {
    return this.db.prepare("UPDATE decisions SET restored = 1 WHERE item_id = ?").run(itemId).changes > 0;
  }

  counts(): { sources: number; items: number; unread: number } {
    const row = this.db.prepare("SELECT (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM items) AS items, (SELECT COUNT(*) FROM items WHERE is_read = 0) AS unread").get() as Row;
    return { sources: Number(row["sources"]), items: Number(row["items"]), unread: Number(row["unread"]) };
  }
}
