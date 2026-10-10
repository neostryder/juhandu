// Delivery of a briefing to email, Telegram and Discord. A daily briefing goes out once to every channel that is on and complete;
// a failed send is retried a few times, then reported on the Connect screen. Private feeds are never sent to Telegram or Discord, and only to
// email when that channel is told to include them. Secrets (the SMTP password, the Telegram or Discord bot token, the webhook address) live in the SecretStore only.
import type { Briefing } from "../briefing/briefer.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Delivery, Store } from "../store/store.ts";
import { buildDigest, renderDiscord, renderHtml, renderTelegram, renderText, testDigest } from "./digest.ts";
import type { Digest } from "./digest.ts";
import { sendMail, validAddress } from "./smtp.ts";
import type { Mail, MailServer } from "./smtp.ts";

export type ChannelId = "email" | "telegram" | "discord";
export const CHANNELS: ChannelId[] = ["email", "telegram", "discord"];

export class NotifyError extends Error {}

export interface EmailConfig {
  enabled: boolean;
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  user: string;
  from: string;
  to: string[];
  includePrivate: boolean;
}

export interface TelegramConfig {
  enabled: boolean;
  chatId: string;
  /** Delivered without a sound or buzz. */
  silent: boolean;
}

export interface DiscordConfig {
  enabled: boolean;
  /** Sent with the suppress-notifications flag, so it does not ping anyone. */
  silent: boolean;
  /** webhook posts to a channel through a webhook address. dm has a bot send a direct message to one person. */
  mode: "webhook" | "dm";
  /** The Discord user id that receives the direct message in dm mode. */
  userId: string;
}

export interface NotifyConfig {
  email: EmailConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
}

export const DEFAULTS: NotifyConfig = {
  email: { enabled: false, host: "", port: 587, security: "starttls", user: "", from: "", to: [], includePrivate: false },
  telegram: { enabled: false, chatId: "", silent: false },
  discord: { enabled: false, silent: true, mode: "webhook", userId: "" },
};

const SECRET_NAMES: Record<ChannelId, string> = { email: "notify.email.password", telegram: "notify.telegram.token", discord: "notify.discord.webhook" };
const DISCORD_DM_SECRET = "notify.discord.token";
const BOT_TOKEN = /^[A-Za-z0-9_-]{16,40}\.[A-Za-z0-9_-]{4,10}\.[A-Za-z0-9_-]{20,100}$/;
const USER_ID = /^\d{15,25}$/;
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_AGENT = "DiscordBot (https://github.com/neostryder/juhandu, 0.1)";
const WEBHOOK = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,200}$/;
const TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{20,80}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/;
const CHAT = /^-?\d{1,20}$|^@[A-Za-z0-9_]{5,32}$/;
const RETRY_MINUTES = 15;
const MAX_ATTEMPTS = 3;
/** A daily briefing older than this is not sent on a later start. */
const FRESH_HOURS = 30;

export interface ChannelStatus {
  id: ChannelId;
  label: string;
  config: EmailConfig | TelegramConfig | DiscordConfig;
  /** True when the secret this channel needs is stored. The secret itself never leaves the SecretStore. */
  secretSet: boolean;
  /** Discord only: whether each way of sending has its secret stored, so the screen can say so before the way is switched. */
  secretsSet?: { webhook: boolean; dm: boolean };
  /** True when it is on and has everything it needs. */
  ready: boolean;
  missing: string[];
  last: { briefingId: number; status: Delivery["status"]; at: string; error: string } | null;
}

export interface NotifierDeps {
  store: Store;
  secrets?: SecretStore;
  getBriefing: (id: number) => Briefing | undefined;
  fetchImpl?: typeof fetch;
  mailer?: (server: MailServer, mail: Mail) => Promise<void>;
  clock?: () => Date;
  /** Pause between the messages of one digest; tests set it to 0. */
  pauseMs?: number;
}

/** The SecretStore name for what a channel needs right now. Discord needs a bot token in dm mode and a webhook address otherwise. */
function secretName(id: ChannelId, config: NotifyConfig): string {
  return id === "discord" && config.discord.mode === "dm" ? DISCORD_DM_SECRET : SECRET_NAMES[id];
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export class Notifier {
  private readonly store: Store;
  private readonly secrets: SecretStore | undefined;
  private readonly getBriefing: NotifierDeps["getBriefing"];
  private readonly fetchImpl: typeof fetch;
  private readonly mailer: NonNullable<NotifierDeps["mailer"]>;
  private readonly clock: () => Date;
  private readonly pauseMs: number;

  constructor(deps: NotifierDeps) {
    this.store = deps.store;
    this.secrets = deps.secrets;
    this.getBriefing = deps.getBriefing;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.mailer = deps.mailer ?? sendMail;
    this.clock = deps.clock ?? (() => new Date());
    this.pauseMs = deps.pauseMs ?? 600;
  }

  config(): NotifyConfig {
    let saved: Partial<NotifyConfig> = {};
    try {
      saved = JSON.parse(this.store.getMeta("notify:config") ?? "{}") as Partial<NotifyConfig>;
    } catch {
      saved = {};
    }
    return { email: { ...DEFAULTS.email, ...saved.email }, telegram: { ...DEFAULTS.telegram, ...saved.telegram }, discord: { ...DEFAULTS.discord, ...saved.discord } };
  }

  /**
   * Checks and stores a change to one channel. A secret is set, or cleared with null. Anything wrong is a NotifyError with a plain message.
   * Telegram and Discord can never be told to include private feeds, because those messages leave for a third party.
   */
  async update(id: ChannelId, patch: Record<string, unknown>, secret?: string | null): Promise<ChannelStatus> {
    const all = this.config();
    if (id === "email") {
      const next: EmailConfig = { ...all.email };
      if (typeof patch["enabled"] === "boolean") next.enabled = patch["enabled"];
      if ("host" in patch) {
        next.host = text(patch["host"], 253);
        if (next.host && !HOST.test(next.host)) throw new NotifyError("That is not a mail server name");
      }
      if ("port" in patch) {
        const port = Number(patch["port"]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NotifyError("The port must be a number from 1 to 65535");
        next.port = port;
      }
      if ("security" in patch) {
        if (patch["security"] !== "tls" && patch["security"] !== "starttls" && patch["security"] !== "none") throw new NotifyError("Security must be tls, starttls or none");
        next.security = patch["security"];
      }
      if ("user" in patch) next.user = text(patch["user"], 200);
      if ("from" in patch) {
        next.from = text(patch["from"], 254);
        if (next.from && !validAddress(next.from)) throw new NotifyError("The From address is not valid");
      }
      if ("to" in patch) {
        const raw = Array.isArray(patch["to"]) ? patch["to"] : typeof patch["to"] === "string" ? patch["to"].split(/[,;\s]+/) : [];
        const list = raw.map((a) => text(a, 254)).filter(Boolean);
        if (list.length > 5) throw new NotifyError("Up to 5 addresses");
        for (const a of list) if (!validAddress(a)) throw new NotifyError(`${a} is not a valid address`);
        next.to = [...new Set(list)];
      }
      if (typeof patch["includePrivate"] === "boolean") next.includePrivate = patch["includePrivate"];
      all.email = next;
    } else if (id === "telegram") {
      const next: TelegramConfig = { ...all.telegram };
      if (typeof patch["enabled"] === "boolean") next.enabled = patch["enabled"];
      if ("chatId" in patch) {
        next.chatId = text(patch["chatId"], 40);
        if (next.chatId && !CHAT.test(next.chatId)) throw new NotifyError("The chat id is a number (it can start with a minus) or @channelname");
      }
      if (typeof patch["silent"] === "boolean") next.silent = patch["silent"];
      if (patch["includePrivate"] === true) throw new NotifyError("Private feeds are never sent to Telegram");
      all.telegram = next;
    } else {
      const next: DiscordConfig = { ...all.discord };
      if (typeof patch["enabled"] === "boolean") next.enabled = patch["enabled"];
      if (typeof patch["silent"] === "boolean") next.silent = patch["silent"];
      if ("mode" in patch) {
        if (patch["mode"] !== "webhook" && patch["mode"] !== "dm") throw new NotifyError("The Discord way must be webhook or dm");
        next.mode = patch["mode"];
      }
      if ("userId" in patch) {
        next.userId = text(patch["userId"], 30);
        if (next.userId && !USER_ID.test(next.userId)) throw new NotifyError("That does not look like a Discord user id, which is a long number. To copy yours, turn on Developer Mode in Discord, then right-click your name and choose Copy User ID");
      }
      if (patch["includePrivate"] === true) throw new NotifyError("Private feeds are never sent to Discord");
      all.discord = next;
    }
    if (secret !== undefined) {
      if (!this.secrets) throw new NotifyError("There is no secret store, so nothing can be saved for this channel");
      const name = secretName(id, all);
      if (secret === null || secret === "") await this.secrets.delete(name);
      else {
        if (id === "telegram" && !TOKEN.test(secret)) throw new NotifyError("That does not look like a Telegram bot token (numbers, a colon, then letters and digits)");
        if (id === "discord" && all.discord.mode === "dm" && !BOT_TOKEN.test(secret)) throw new NotifyError("That does not look like a Discord bot token (three parts joined by dots). Copy it from your bot's page in the Discord Developer Portal");
        if (id === "discord" && all.discord.mode === "webhook" && !WEBHOOK.test(secret)) throw new NotifyError("That does not look like a Discord webhook address (https://discord.com/api/webhooks/...)");
        if (/[\r\n]/.test(secret) || secret.length > 500) throw new NotifyError("That value is not usable");
        await this.secrets.set(name, secret);
      }
    }
    this.store.setMeta("notify:config", JSON.stringify(all));
    return (await this.status()).find((s) => s.id === id) as ChannelStatus;
  }

  async status(): Promise<ChannelStatus[]> {
    const config = this.config();
    const last = new Map<string, Delivery>();
    for (const d of this.store.listDeliveries(60).reverse()) last.set(d.channel, d);
    const out: ChannelStatus[] = [];
    for (const id of CHANNELS) {
      const secretSet = this.secrets ? Boolean(await this.secrets.get(secretName(id, config))) : false;
      const discordSecrets = id === "discord" ? { webhook: this.secrets ? Boolean(await this.secrets.get(SECRET_NAMES.discord)) : false, dm: this.secrets ? Boolean(await this.secrets.get(DISCORD_DM_SECRET)) : false } : undefined;
      const missing: string[] = [];
      if (id === "email") {
        if (!config.email.host) missing.push("a mail server");
        if (!config.email.from) missing.push("a From address");
        if (!config.email.to.length) missing.push("a To address");
        if (config.email.user && !secretSet) missing.push("the password");
      } else if (id === "telegram") {
        if (!secretSet) missing.push("the bot token");
        if (!config.telegram.chatId) missing.push("a chat id");
      } else if (config.discord.mode === "dm") {
        if (!secretSet) missing.push("the bot token");
        if (!config.discord.userId) missing.push("your Discord user id");
      } else if (!secretSet) missing.push("the webhook address");
      const d = last.get(id);
      out.push({
        id,
        label: id === "email" ? "Email" : id === "telegram" ? "Telegram" : "Discord",
        config: config[id],
        secretSet,
        ...(discordSecrets ? { secretsSet: discordSecrets } : {}),
        ready: config[id].enabled && missing.length === 0,
        missing,
        last: d ? { briefingId: d.briefingId, status: d.status, at: d.deliveredAt ?? d.updatedAt, error: d.lastError } : null,
      });
    }
    return out;
  }

  private async pause(): Promise<void> {
    if (this.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
  }

  /** Sends one digest through one channel. Throws a plain-language error when it fails. */
  private async transmit(id: ChannelId, digest: Digest): Promise<void> {
    const config = this.config();
    const secret = this.secrets ? await this.secrets.get(secretName(id, config)) : undefined;
    const scrub = (message: string): string => (secret ? message.split(secret).join("***") : message);
    try {
      if (id === "email") {
        const c = config.email;
        await this.mailer(
          { host: c.host, port: c.port, security: c.security, ...(c.user ? { user: c.user } : {}), ...(secret ? { password: secret } : {}) },
          { from: c.from, to: c.to, subject: digest.title, text: renderText(digest), html: renderHtml(digest) },
        );
      } else if (id === "telegram") {
        if (!secret) throw new NotifyError("The bot token is not set");
        const messages = renderTelegram(digest);
        for (const [i, message] of messages.entries()) {
          if (i) await this.pause();
          const response = await this.fetchImpl(`https://api.telegram.org/bot${secret}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: config.telegram.chatId, text: message, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: config.telegram.silent }),
          });
          const body = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
          if (!response.ok || body.ok === false) throw new NotifyError(`Telegram said: ${body.description ?? response.status}`);
        }
      } else if (config.discord.mode === "dm") {
        if (!secret) throw new NotifyError("The bot token is not set");
        if (!config.discord.userId) throw new NotifyError("The Discord user id is not set");
        const headers = { authorization: `Bot ${secret}`, "content-type": "application/json", "user-agent": DISCORD_AGENT };
        const opened = await this.fetchImpl(`${DISCORD_API}/users/@me/channels`, { method: "POST", headers, body: JSON.stringify({ recipient_id: config.discord.userId }) });
        const dm = (await opened.json().catch(() => ({}))) as { id?: string; message?: string };
        if (!opened.ok || !dm.id) throw new NotifyError(`Discord said: ${dm.message ?? opened.status}`);
        for (const [i, message] of renderDiscord(digest).entries()) {
          if (i) await this.pause();
          const response = await this.fetchImpl(`${DISCORD_API}/channels/${dm.id}/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ content: message, allowed_mentions: { parse: [] }, flags: config.discord.silent ? 4096 : 0 }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { message?: string; code?: number };
            const hint = body.code === 50007 ? " (the bot cannot message you. You and the bot must share a server, and your privacy settings for that server must allow direct messages from server members)" : response.status === 429 ? " (slow down, it will be retried)" : "";
            throw new NotifyError(`Discord said: ${body.message ?? response.status}${hint}`);
          }
        }
      } else {
        if (!secret) throw new NotifyError("The webhook address is not set");
        const messages = renderDiscord(digest);
        for (const [i, message] of messages.entries()) {
          if (i) await this.pause();
          const response = await this.fetchImpl(secret, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: "Juhandu", content: message, allowed_mentions: { parse: [] }, flags: config.discord.silent ? 4096 : 0 }),
          });
          if (!response.ok) throw new NotifyError(`Discord said: ${response.status}${response.status === 429 ? " (slow down, it will be retried)" : ""}`);
        }
      }
    } catch (error) {
      throw new NotifyError(scrub(error instanceof Error ? error.message : String(error)));
    }
  }

  /** Sends a short test through one channel, even when it is switched off. */
  async test(id: ChannelId): Promise<void> {
    const status = (await this.status()).find((s) => s.id === id) as ChannelStatus;
    if (status.missing.length) throw new NotifyError(`Still needed: ${status.missing.join(", ")}`);
    await this.transmit(id, testDigest());
  }

  private digestFor(id: ChannelId, briefing: Briefing): Digest {
    const tiers = this.store.itemTiers(briefing.sections.flatMap((s) => s.entries.flatMap((e) => e.links.map((l) => l.id))));
    return buildDigest(briefing, tiers, { includePrivate: id === "email" && this.config().email.includePrivate });
  }

  /**
   * Sends one briefing to the channels that are on and complete. Without force, a channel that already has it (or is waiting out a retry) is skipped.
   * Returns what happened per channel.
   */
  async deliverBriefing(briefingId: number, options: { force?: boolean; only?: ChannelId[] } = {}): Promise<{ channel: ChannelId; result: "sent" | "retry" | "failed" | "skipped"; detail: string }[]> {
    const briefing = this.getBriefing(briefingId);
    if (!briefing) throw new NotifyError("No such briefing");
    const now = this.clock();
    const results: { channel: ChannelId; result: "sent" | "retry" | "failed" | "skipped"; detail: string }[] = [];
    for (const status of await this.status()) {
      if (options.only && !options.only.includes(status.id)) continue;
      if (!status.ready) {
        if (options.only) results.push({ channel: status.id, result: "skipped", detail: status.config.enabled ? `Still needed: ${status.missing.join(", ")}` : "This channel is switched off" });
        continue;
      }
      const existing = this.store.getDelivery(briefingId, status.id);
      if (!options.force && existing) {
        if (existing.status === "sent" || existing.status === "failed") {
          results.push({ channel: status.id, result: "skipped", detail: "Already handled" });
          continue;
        }
        if (existing.nextAttemptAt && Date.parse(existing.nextAttemptAt) > now.getTime()) {
          results.push({ channel: status.id, result: "skipped", detail: "Waiting to retry" });
          continue;
        }
      }
      const digest = this.digestFor(status.id, briefing);
      const attempts = (existing?.status === "retry" || options.force ? (existing?.attempts ?? 0) : 0) + 1;
      if (digest.entryCount === 0) {
        this.store.saveDelivery({ briefingId, channel: status.id, status: "sent", attempts, lastError: digest.withheld ? "Nothing to send: every item is from a private feed" : "Nothing to send", nextAttemptAt: null, deliveredAt: now.toISOString() }, now);
        results.push({ channel: status.id, result: "skipped", detail: "Nothing to send" });
        continue;
      }
      try {
        await this.transmit(status.id, digest);
        this.store.saveDelivery({ briefingId, channel: status.id, status: "sent", attempts, lastError: "", nextAttemptAt: null, deliveredAt: this.clock().toISOString() }, now);
        results.push({ channel: status.id, result: "sent", detail: `${digest.entryCount} items` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const giveUp = attempts >= MAX_ATTEMPTS;
        this.store.saveDelivery({ briefingId, channel: status.id, status: giveUp ? "failed" : "retry", attempts, lastError: message, nextAttemptAt: giveUp ? null : new Date(now.getTime() + RETRY_MINUTES * 60_000 * attempts).toISOString(), deliveredAt: null }, now);
        results.push({ channel: status.id, result: giveUp ? "failed" : "retry", detail: message });
      }
    }
    return results;
  }

  /** The step the minute tick runs: the newest recent daily briefing goes out to every ready channel that has not had it. */
  async deliverDue(): Promise<{ sent: number; failed: number }> {
    const now = this.clock().getTime();
    let sent = 0;
    let failed = 0;
    const daily = this.store.listBriefings(5).find((b) => b.kind === "daily" && now - Date.parse(b.createdAt) < FRESH_HOURS * 3_600_000);
    if (!daily) return { sent, failed };
    for (const r of await this.deliverBriefing(daily.id)) {
      if (r.result === "sent") sent++;
      if (r.result === "failed" || r.result === "retry") failed++;
    }
    return { sent, failed };
  }
}
