// The mail door: newsletter mail that another program (Mercury, for the author's setup) has already accepted arrives here as JSON and becomes
// ordinary items, one source per newsletter. The door holds no mailbox login and reads nothing; a token made on the Connect screen can only add items.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "../secrets/store.ts";
import type { NewItem, Store } from "../store/store.ts";
import { excerpt, htmlToText, titleHash } from "../text.ts";

const TOKEN_SECRET = "mail.token";
/** The largest request body the door reads. */
export const MAX_MAIL_BODY = 2 * 1024 * 1024;
const RATE_PER_MINUTE = 120;
const FOLDER = "Newsletters";
const MAX_TEXT = 200_000;
const MAX_HTML = 400_000;

export class MailError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface MailStatus {
  tokenSet: boolean;
  lastReceivedAt: string | null;
  receivedToday: number;
}

export interface MailResult {
  inserted: boolean;
  itemId: number | null;
  sourceId: number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

const ADDRESS = /^[^\s<>@,;"()[\]\\]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** A List-Id header is often `Name <id.example.com>`; the id between the brackets (or the whole value) is the key. */
function listIdKey(raw: string): string {
  const inner = /<([^>]+)>/.exec(raw)?.[1] ?? raw;
  return inner.trim().toLowerCase().slice(0, 300);
}

/** An anchor whose words say it is the web copy of the message, found in the HTML. Only http and https links count. */
export function webVersionLink(html: string): string {
  const anchors = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  const words = /\b(view|read|open|see)\b[^.]{0,30}\b(browser|online|web)\b|\bweb version\b|\bonline version\b/i;
  for (const match of html.matchAll(anchors)) {
    const href = (match[1] ?? match[2] ?? "").trim();
    if (!/^https?:\/\//i.test(href) || href.length > 2000) continue;
    if (words.test(htmlToText(match[3] ?? ""))) return href;
  }
  return "";
}

export class MailDoor {
  private readonly store: Store;
  private readonly secrets: SecretStore | undefined;
  private readonly clock: () => Date;
  private recent: number[] = [];

  constructor(options: { store: Store; secrets?: SecretStore; clock?: () => Date }) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.clock = options.clock ?? (() => new Date());
  }

  async tokenSet(): Promise<boolean> {
    return this.secrets ? Boolean(await this.secrets.get(TOKEN_SECRET)) : false;
  }

  async status(): Promise<MailStatus> {
    let today = 0;
    try {
      const saved = JSON.parse(this.store.getMeta("mail:day") ?? "{}") as { date?: string; count?: number };
      if (saved.date === this.dayKey() && typeof saved.count === "number") today = saved.count;
    } catch {
      today = 0;
    }
    return { tokenSet: await this.tokenSet(), lastReceivedAt: this.store.getMeta("mail:last") ?? null, receivedToday: today };
  }

  /** Makes a new token, replacing any old one. It is returned once and never again. */
  async newToken(): Promise<string> {
    if (!this.secrets) throw new Error("There is no secret store, so a token cannot be kept");
    const token = `jhm_${randomBytes(24).toString("base64url")}`;
    await this.secrets.set(TOKEN_SECRET, token);
    return token;
  }

  async clearToken(): Promise<void> {
    await this.secrets?.delete(TOKEN_SECRET);
  }

  /** True only when a token is set and the Authorization header carries it. With no token the door is off. */
  async authorized(authorization: string | undefined): Promise<boolean> {
    const token = this.secrets ? await this.secrets.get(TOKEN_SECRET) : undefined;
    if (!token) return false;
    const given = /^Bearer (.+)$/i.exec(authorization ?? "")?.[1] ?? "";
    return timingSafeEqual(digest(given), digest(token));
  }

  private dayKey(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  /** Throws a 429 once more than RATE_PER_MINUTE requests came in during the last minute. */
  checkRate(): void {
    const now = this.clock().getTime();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= RATE_PER_MINUTE) throw new MailError(429, "Wait a minute before sending more, because this server accepts at most 120 messages a minute.");
    this.recent.push(now);
  }

  /** Validates one pushed message and stores it. A message already held (same messageId from the same newsletter) is not stored again. */
  accept(body: Record<string, unknown>): MailResult {
    const now = this.clock();
    const messageId = str(body["messageId"], 998);
    if (!messageId) throw new MailError(400, "messageId is required and must be a string.");
    const from = body["from"];
    const address = from && typeof from === "object" ? str((from as Record<string, unknown>)["address"], 254).toLowerCase() : "";
    if (!ADDRESS.test(address)) throw new MailError(400, "Add the sender's email address as from.address.");
    const fromName = from && typeof from === "object" ? str((from as Record<string, unknown>)["name"], 200) : "";
    const text = typeof body["text"] === "string" ? body["text"].slice(0, MAX_TEXT) : "";
    const html = typeof body["html"] === "string" ? body["html"].slice(0, MAX_HTML) : "";
    if (!text.trim() && !html.trim()) throw new MailError(400, "The message has neither a text nor an html field, and at least one is required.");
    const subject = str(body["subject"], 500);
    const listId = listIdKey(str(body["listId"], 400));
    const unsubscribe = Array.isArray(body["listUnsubscribe"])
      ? body["listUnsubscribe"].flatMap((v) => (typeof v === "string" && /^(https?:|mailto:)/i.test(v.trim()) && v.trim().length <= 500 ? [v.trim()] : [])).slice(0, 10)
      : [];
    let publishedAt = now.toISOString();
    const given = typeof body["date"] === "string" ? Date.parse(body["date"]) : NaN;
    if (Number.isFinite(given) && given <= now.getTime() + 24 * 3600_000) publishedAt = new Date(given).toISOString();

    const key = listId ? `list:${listId}` : `from:${address}`;
    const url = `mail:${key}`;
    const source = this.store.findSourceByUrl(url) ?? this.store.addSource({ kind: "mail", url, title: fromName || address, folder: FOLDER, tier: "private", pollMinutes: 1440 }, now);

    const plain = text.trim() ? text : htmlToText(html);
    const summaryText = excerpt(plain.replace(/\s+\n/g, "\n"));
    const title = subject || (summaryText.split("\n")[0] ?? "").slice(0, 120) || "(no subject)";
    const extra: Record<string, string> = { from: address };
    if (listId) extra["listId"] = listId;
    if (unsubscribe.length) extra["unsubscribe"] = unsubscribe.join(" ");
    const category = str(body["category"], 40);
    const verdict = str(body["verdict"], 40);
    if (category) extra["category"] = category;
    if (verdict) extra["verdict"] = verdict;
    const item: NewItem = {
      guid: messageId,
      url: html ? webVersionLink(html) : "",
      title,
      author: fromName || address,
      publishedAt,
      summaryText,
      contentHtml: html || text,
      image: "",
      titleHash: titleHash(title),
      extra,
    };
    const inserted = this.store.upsertItems(source.id, [item], now) > 0;
    if (inserted) this.count(now);
    return { inserted, itemId: this.store.itemIdByGuid(source.id, messageId) ?? null, sourceId: source.id };
  }

  private count(now: Date): void {
    let today = 0;
    try {
      const saved = JSON.parse(this.store.getMeta("mail:day") ?? "{}") as { date?: string; count?: number };
      if (saved.date === this.dayKey() && typeof saved.count === "number") today = saved.count;
    } catch {
      today = 0;
    }
    this.store.setMeta("mail:day", JSON.stringify({ date: this.dayKey(), count: today + 1 }));
    this.store.setMeta("mail:last", now.toISOString());
  }
}
