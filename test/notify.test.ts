import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Briefer } from "../src/briefing/briefer.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Notifier } from "../src/notify/notifier.ts";
import { buildDigest, renderDiscord, renderHtml, renderTelegram, renderText } from "../src/notify/digest.ts";
import { SmtpError, buildMessage, encodeHeader, sendMail, validAddress } from "../src/notify/smtp.ts";
import type { Mail, MailServer } from "../src/notify/smtp.ts";
import { Processor } from "../src/pipeline/process.ts";
import { SecretStore } from "../src/secrets/store.ts";
import type { SecretBackend } from "../src/secrets/store.ts";
import { Store } from "../src/store/store.ts";
import type { NewItem } from "../src/store/store.ts";

const NOW = new Date("2026-10-07T13:00:00Z");
const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAA-secret_token_BBBB";
const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEFG-123456";

function item(guid: string, title: string, text = "Body text for the item."): NewItem {
  return { guid, url: `https://x.example/${guid}`, title, author: "", publishedAt: "2026-10-07T10:00:00Z", summaryText: text, contentHtml: "", image: "", titleHash: guid, extra: {} };
}

class MemBackend implements SecretBackend {
  readonly id = "mem";
  readonly writable = true;
  readonly values = new Map<string, string>();
  async available() {
    return true;
  }
  async get(name: string) {
    return this.values.get(name);
  }
  async set(name: string, value: string) {
    this.values.set(name, value);
  }
  async delete(name: string) {
    this.values.delete(name);
  }
}

async function fixture() {
  const store = new Store(":memory:");
  const pub = store.addSource({ kind: "feed", url: "https://pub.example/feed", folder: "News", tier: "public" });
  const priv = store.addSource({ kind: "feed", url: "https://priv.example/feed", folder: "Work", tier: "private" });
  store.upsertItems(pub.id, [item("p1", "Tags <b>& \"quotes\" [x](y) *bold*"), item("p2", "A plain headline")], NOW);
  store.upsertItems(priv.id, [item("w1", "Quarterly numbers leaked")], NOW);
  await new Processor(store, null, () => NOW).decidePending();
  const briefer = new Briefer(store, () => NOW);
  const briefing = briefer.build({ kind: "daily" });
  const backend = new MemBackend();
  const secrets = new SecretStore([backend]);
  return { store, briefer, briefing, secrets, backend };
}

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function fakeFetch(calls: Call[], answer: (call: Call) => Response = () => Response.json({ ok: true })): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
}

test("a digest leaves out private feeds and renders hostile text safely", async () => {
  const { store, briefing } = await fixture();
  const tiers = store.itemTiers(briefing.sections.flatMap((s) => s.entries.flatMap((e) => e.links.map((l) => l.id))));
  const digest = buildDigest(briefing, tiers, { includePrivate: false });
  assert.equal(digest.withheld, 1);
  assert.equal(digest.entryCount, 2);
  const all = [renderText(digest), renderHtml(digest), ...renderTelegram(digest), ...renderDiscord(digest)].join("\n");
  assert.ok(!all.includes("Quarterly"), "the private headline is never rendered");
  assert.match(renderText(digest), /1 item from private feeds is not included/);
  const html = renderHtml(digest);
  assert.ok(!html.includes("<b>&"), "html escapes the title");
  assert.match(html, /&lt;b&gt;&amp;/);
  const telegram = renderTelegram(digest).join("\n");
  assert.ok(!telegram.includes("<b>&"), "telegram escapes the title");
  const discord = renderDiscord(digest).join("\n");
  assert.match(discord, /\\\[x\\\]\\\(y\\\)/, "discord escapes markdown links in feed text");
  const withPrivate = buildDigest(briefing, tiers, { includePrivate: true });
  assert.equal(withPrivate.entryCount, 3);
  store.close();
});

test("a long digest is split under each channel's limit", () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({ text: `Headline number ${i} `.repeat(12), unchecked: false, headlineOnly: false, pinned: false, links: [{ title: "Read", source: "S", url: `https://x.example/${i}` }] }));
  const digest = { briefingId: 1, title: "t", period: "p", entryCount: 80, sections: [{ folder: "F", entries, omitted: 0 }], withheld: 0 };
  const telegram = renderTelegram(digest);
  const discord = renderDiscord(digest);
  assert.ok(telegram.length > 1 && telegram.every((m) => m.length <= 4096));
  assert.ok(discord.length > 1 && discord.every((m) => m.length <= 2000));
});

test("telegram and discord get the briefing once, without private items, and the secrets stay out of the status", async () => {
  const { store, briefing, briefer, secrets } = await fixture();
  const calls: Call[] = [];
  const notifier = new Notifier({ store, secrets, getBriefing: (id) => briefer.get(id) ?? undefined, fetchImpl: fakeFetch(calls), clock: () => NOW, pauseMs: 0 });
  await notifier.update("telegram", { enabled: true, chatId: "-100123" }, TOKEN);
  await notifier.update("discord", { enabled: true }, WEBHOOK);
  const status = JSON.stringify(await notifier.status());
  assert.ok(!status.includes(TOKEN) && !status.includes("AAAAAAAA") && !status.includes("abcdefghij"), "status never carries a secret");

  const first = await notifier.deliverBriefing(briefing.id);
  assert.deepEqual(first.map((r) => [r.channel, r.result]), [["telegram", "sent"], ["discord", "sent"]]);
  const telegram = calls.find((c) => c.url.startsWith("https://api.telegram.org/bot"));
  assert.ok(telegram && telegram.url.includes(TOKEN));
  assert.equal(telegram.body["parse_mode"], "HTML");
  assert.equal(telegram.body["chat_id"], "-100123");
  const discord = calls.find((c) => c.url === WEBHOOK);
  assert.ok(discord);
  assert.deepEqual(discord.body["allowed_mentions"], { parse: [] });
  assert.equal(discord.body["flags"], 4096);
  assert.ok(!JSON.stringify(calls.map((c) => c.body)).includes("Quarterly"));

  const sentBefore = calls.length;
  const again = await notifier.deliverBriefing(briefing.id);
  assert.deepEqual(again.map((r) => r.result), ["skipped", "skipped"]);
  assert.equal(calls.length, sentBefore, "a briefing is not sent twice");
  store.close();
});

test("private feeds can go to email only when told to, and never to telegram or discord", async () => {
  const { store, briefing, briefer, secrets } = await fixture();
  const mails: Mail[] = [];
  const notifier = new Notifier({ store, secrets, getBriefing: (id) => briefer.get(id) ?? undefined, mailer: async (_s, m) => void mails.push(m), clock: () => NOW, pauseMs: 0 });
  await assert.rejects(notifier.update("telegram", { includePrivate: true }), /never sent to Telegram/);
  await assert.rejects(notifier.update("discord", { includePrivate: true }), /never sent to Discord/);
  await notifier.update("email", { enabled: true, host: "smtp.example.com", from: "juhandu@example.com", to: ["me@example.com"] });
  await notifier.deliverBriefing(briefing.id);
  assert.equal(mails.length, 1);
  assert.ok(!mails[0]!.text.includes("Quarterly"));
  await notifier.update("email", { includePrivate: true });
  await notifier.deliverBriefing(briefing.id, { force: true });
  assert.equal(mails.length, 2);
  assert.match(mails[1]!.text, /Quarterly/);
  assert.equal(mails[1]!.to[0], "me@example.com");
  store.close();
});

test("a failed send is retried later, then given up, and the error never shows the secret", async () => {
  const { store, briefing, briefer, secrets } = await fixture();
  let now = NOW;
  const calls: Call[] = [];
  const notifier = new Notifier({
    store,
    secrets,
    getBriefing: (id) => briefer.get(id) ?? undefined,
    fetchImpl: fakeFetch(calls, () => {
      throw new Error(`connect failed to https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }),
    clock: () => now,
    pauseMs: 0,
  });
  await notifier.update("telegram", { enabled: true, chatId: "42" }, TOKEN);
  const r1 = await notifier.deliverBriefing(briefing.id);
  assert.equal(r1[0]!.result, "retry");
  assert.ok(!r1[0]!.detail.includes(TOKEN) && r1[0]!.detail.includes("***"));
  assert.equal((await notifier.deliverBriefing(briefing.id))[0]!.detail, "Waiting to retry");
  now = new Date(NOW.getTime() + 16 * 60_000);
  assert.equal((await notifier.deliverBriefing(briefing.id))[0]!.result, "retry");
  now = new Date(NOW.getTime() + 3 * 3_600_000);
  assert.equal((await notifier.deliverBriefing(briefing.id))[0]!.result, "failed");
  now = new Date(NOW.getTime() + 6 * 3_600_000);
  assert.equal((await notifier.deliverBriefing(briefing.id))[0]!.detail, "Already handled");
  const state = (await notifier.status())[1]!;
  assert.equal(state.last?.status, "failed");
  assert.ok(!state.last?.error.includes(TOKEN));
  store.close();
});

test("only the newest fresh daily briefing goes out on the tick", async () => {
  const { store, briefer, secrets } = await fixture();
  const calls: Call[] = [];
  const notifier = new Notifier({ store, secrets, getBriefing: (id) => briefer.get(id) ?? undefined, fetchImpl: fakeFetch(calls), clock: () => NOW, pauseMs: 0 });
  await notifier.update("discord", { enabled: true }, WEBHOOK);
  assert.deepEqual(await notifier.deliverDue(), { sent: 1, failed: 0 });
  assert.deepEqual(await notifier.deliverDue(), { sent: 0, failed: 0 });
  const late = new Notifier({ store, secrets, getBriefing: (id) => briefer.get(id) ?? undefined, fetchImpl: fakeFetch(calls), clock: () => new Date(NOW.getTime() + 40 * 3_600_000), pauseMs: 0 });
  assert.deepEqual(await late.deliverDue(), { sent: 0, failed: 0 }, "a briefing older than a day and a half is not sent late");
  store.close();
});

test("channel settings are checked", async () => {
  const { store, secrets, briefer } = await fixture();
  const notifier = new Notifier({ store, secrets, getBriefing: (id) => briefer.get(id) ?? undefined });
  await assert.rejects(notifier.update("telegram", {}, "not a token"), /bot token/);
  await assert.rejects(notifier.update("discord", {}, "https://evil.example/api/webhooks/1/2"), /webhook/);
  await assert.rejects(notifier.update("email", { host: "bad host!" }), /mail server name/);
  await assert.rejects(notifier.update("email", { to: ["nope"] }), /not a valid address/);
  await assert.rejects(notifier.update("email", { port: 0 }), /port/);
  await assert.rejects(notifier.test("telegram"), /Still needed/);
  const cleared = await notifier.update("telegram", {}, null);
  assert.equal(cleared.secretSet, false);
  store.close();
});

// ---- SMTP ----

test("mail headers and bodies are encoded and dot-stuffed", () => {
  assert.equal(encodeHeader("plain"), "plain");
  assert.match(encodeHeader("Briefing déjà vu"), /^=\?UTF-8\?B\?/);
  assert.ok(validAddress("a.b+c@example.com") && !validAddress("a@b@c") && !validAddress("a b@c.com"));
  const message = buildMessage({ from: "a@example.com", to: ["b@example.com"], subject: "Hi", text: "hello", html: "<p>hello</p>" }, NOW, "id1");
  assert.match(message, /^From: a@example\.com\r\nTo: b@example\.com\r\nSubject: Hi\r\n/);
  assert.match(message, /Content-Type: multipart\/alternative; boundary=/);
  assert.ok(!/(^|\r\n)\.(?!\.)/.test(message), "no line starts with a lone dot");
  assert.throws(() => buildMessage({ from: "a@example.com", to: ["b@example.com"], subject: "x\r\nBcc: z@example.com", text: "t" }, NOW), SmtpError);
});

/** A tiny SMTP server that records what the client says. */
async function smtpServer(options: { auth?: boolean; rejectRcpt?: boolean } = {}) {
  const log: string[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.write("220 test ESMTP\r\n");
    let data = false;
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 queued\r\n");
          } else log.push("DATA> " + line);
          continue;
        }
        log.push(line);
        if (line.startsWith("EHLO")) socket.write(options.auth ? "250-test\r\n250 AUTH PLAIN LOGIN\r\n" : "250 test\r\n");
        else if (line.startsWith("AUTH PLAIN")) socket.write("235 ok\r\n");
        else if (line.startsWith("RCPT") && options.rejectRcpt) socket.write("550 no such user\r\n");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) socket.write("250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("500 what\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { log, port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("sendMail speaks SMTP to a local server and logs in with PLAIN", async () => {
  const smtp = await smtpServer({ auth: true });
  try {
    const server: MailServer = { host: "127.0.0.1", port: smtp.port, security: "none", user: "me", password: "pw", timeoutMs: 5000 };
    await sendMail(server, { from: "a@example.com", to: ["b@example.com", "c@example.com"], subject: "Subject line", text: "Body" }, NOW);
    assert.ok(smtp.log.some((l) => l === `AUTH PLAIN ${Buffer.from("\0me\0pw").toString("base64")}`));
    assert.ok(smtp.log.includes("MAIL FROM:<a@example.com>"));
    assert.equal(smtp.log.filter((l) => l.startsWith("RCPT TO:")).length, 2);
    assert.ok(smtp.log.some((l) => l === "DATA> Subject: Subject line"));
  } finally {
    await smtp.close();
  }
});

test("sendMail reports a rejected recipient plainly and refuses an unencrypted password to another host", async () => {
  const smtp = await smtpServer({ rejectRcpt: true });
  try {
    await assert.rejects(sendMail({ host: "127.0.0.1", port: smtp.port, security: "none", timeoutMs: 5000 }, { from: "a@example.com", to: ["b@example.com"], subject: "s", text: "t" }), /550 no such user/);
  } finally {
    await smtp.close();
  }
  await assert.rejects(sendMail({ host: "mail.example.com", port: 25, security: "none", user: "u", password: "p" }, { from: "a@example.com", to: ["b@example.com"], subject: "s", text: "t" }), /never sent over an unencrypted/);
});

// ---- the API ----

test("the notify API stores channel secrets without ever returning them", async () => {
  const { store, briefer, secrets, backend } = await fixture();
  const calls: Call[] = [];
  const notifier = new Notifier({ store, secrets, getBriefing: (id) => briefer.get(id) ?? undefined, fetchImpl: fakeFetch(calls), clock: () => NOW, pauseMs: 0 });
  const app = createApp({ store, ingestor: new Ingestor(store), secrets, briefer, notifier, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, text: await response.text() };
  };
  try {
    const put = await call("PUT", "/api/notify/telegram", { enabled: true, chatId: "42", secret: TOKEN });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes(TOKEN) && put.text.includes('"secretSet":true'));
    assert.equal(backend.values.get("notify.telegram.token"), TOKEN);
    const bad = await call("PUT", "/api/notify/discord", { secret: "nope" });
    assert.equal(bad.status, 422);
    assert.equal((await call("PUT", "/api/notify/fax", {})).status, 404);
    assert.ok(!(await call("GET", "/api/notify")).text.includes(TOKEN));
    assert.equal((await call("POST", "/api/notify/telegram/test")).status, 200);
    assert.ok(calls.some((c) => String(c.body["text"]).includes("test message")));
    const send = await call("POST", "/api/notify/send", { channels: ["telegram"] });
    assert.equal(send.status, 200);
    assert.match(send.text, /"result":"sent"/);
  } finally {
    await new Promise<void>((resolve) => app.close(() => resolve()));
    store.close();
  }
});
