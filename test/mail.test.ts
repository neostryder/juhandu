import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { MailDoor, webVersionLink } from "../src/mail/door.ts";
import { SecretStore } from "../src/secrets/store.ts";
import type { SecretBackend } from "../src/secrets/store.ts";
import { Store } from "../src/store/store.ts";

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

const NOW = new Date("2026-11-02T15:00:00Z");

const ISSUE = {
  messageId: "<issue-41@news.example>",
  from: { name: "The Weekly Byte", address: "Editor@News.example" },
  subject: "Issue 41: Rust in the kernel",
  date: "2026-11-02T12:30:00Z",
  listId: "The Weekly Byte <weekly.news.example>",
  listUnsubscribe: ["https://news.example/unsub?u=1", "mailto:unsub@news.example", "javascript:alert(1)"],
  text: "Welcome to issue 41.\n\nThis week: Rust in the kernel.",
  html: '<p>Welcome</p><a href="https://news.example/web/41">View in browser</a>',
  category: "NEWSLETTER",
  verdict: "250",
};

async function serve(withToken = true, clock?: () => Date) {
  const store = new Store(":memory:");
  const secrets = new SecretStore([new MemBackend()]);
  const mail = new MailDoor({ store, secrets, ...(clock ? { clock } : {}) });
  const app = createApp({ store, ingestor: new Ingestor(store), secrets, mail, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  const port = (app.address() as AddressInfo).port;
  const token = withToken ? await mail.newToken() : undefined;
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
    });
  const push = (body: unknown, extra: Record<string, string> = {}) => call("POST", "/inbound/mail", { authorization: `Bearer ${token}`, ...extra }, body);
  return { call, push, token, store, mail, close: () => new Promise<void>((resolve) => app.close(() => resolve())) };
}

test("the door is off (404) until a token exists, and answers only POST", async () => {
  const s = await serve(false);
  try {
    assert.equal((await s.call("POST", "/inbound/mail", {}, ISSUE)).status, 404);
    await s.mail.newToken();
    assert.equal((await s.call("GET", "/inbound/mail", {})).status, 405);
  } finally {
    await s.close();
    s.store.close();
  }
});

test("a missing, wrong or look-alike token is refused and nothing is stored", async () => {
  const s = await serve();
  try {
    assert.equal((await s.call("POST", "/inbound/mail", {}, ISSUE)).status, 401);
    assert.equal((await s.call("POST", "/inbound/mail", { authorization: "Bearer jhm_wrong" }, ISSUE)).status, 401);
    assert.equal((await s.call("POST", "/inbound/mail", { authorization: `Basic ${s.token}` }, ISSUE)).status, 401);
    assert.equal((await s.call("POST", "/inbound/mail", { authorization: `Bearer ${s.token}x` }, ISSUE)).status, 401);
    assert.equal(s.store.listSources().length, 0);
    assert.match(s.token ?? "", /^jhm_/);
  } finally {
    await s.close();
    s.store.close();
  }
});

test("a pushed issue becomes one private item under a Newsletters source, and a repeat is not stored twice", async () => {
  const s = await serve(true, () => NOW);
  try {
    const first = await s.push(ISSUE);
    assert.equal(first.status, 201);
    const created = JSON.parse(first.text) as { inserted: boolean; itemId: number };
    assert.equal(created.inserted, true);
    const sources = s.store.listSources();
    assert.equal(sources.length, 1);
    const source = sources[0]!;
    assert.equal(source.kind, "mail");
    assert.equal(source.url, "mail:list:weekly.news.example");
    assert.equal(source.folder, "Newsletters");
    assert.equal(source.tier, "private");
    assert.equal(source.title, "The Weekly Byte");
    const [item] = s.store.listItems({ sourceId: source.id });
    assert.ok(item);
    assert.equal(item.id, created.itemId);
    assert.equal(item.title, "Issue 41: Rust in the kernel");
    assert.equal(item.author, "The Weekly Byte");
    assert.equal(item.url, "https://news.example/web/41");
    assert.equal(item.publishedAt, "2026-11-02T12:30:00.000Z");
    assert.match(item.summaryText, /Welcome to issue 41/);
    assert.deepEqual(item.extra, { from: "editor@news.example", listId: "weekly.news.example", unsubscribe: "https://news.example/unsub?u=1 mailto:unsub@news.example", category: "NEWSLETTER", verdict: "250" });

    const again = await s.push(ISSUE);
    assert.equal(again.status, 200);
    assert.deepEqual(JSON.parse(again.text), { inserted: false });
    assert.equal(s.store.listItems({ sourceId: source.id }).length, 1);
    const status = await s.mail.status();
    assert.equal(status.receivedToday, 1);
    assert.equal(status.lastReceivedAt, NOW.toISOString());
  } finally {
    await s.close();
    s.store.close();
  }
});

test("issues of one newsletter share a source; a sender with no list id is keyed by address", async () => {
  const s = await serve();
  try {
    await s.push(ISSUE);
    await s.push({ ...ISSUE, messageId: "<issue-42@news.example>", subject: "Issue 42" });
    await s.push({ messageId: "<solo-1>", from: { address: "Hello@Solo.example" }, text: "Plain letter" });
    const sources = s.store.listSources();
    assert.equal(sources.length, 2);
    assert.ok(sources.some((x) => x.url === "mail:from:hello@solo.example" && x.title === "hello@solo.example"));
    const weekly = sources.find((x) => x.url === "mail:list:weekly.news.example");
    assert.equal(s.store.listItems({ sourceId: weekly?.id as number }).length, 2);
  } finally {
    await s.close();
    s.store.close();
  }
});

test("a body with no text or html, no messageId or no address is a 400 with a reason", async () => {
  const s = await serve();
  try {
    const cases: [unknown, RegExp][] = [
      [{ ...ISSUE, messageId: "" }, /messageId/],
      [{ ...ISSUE, from: { name: "x" } }, /from\.address/],
      [{ ...ISSUE, from: { address: "not an address" } }, /from\.address/],
      [{ ...ISSUE, text: "", html: "  " }, /text nor an html/],
      ["{", /JSON/],
      [[1, 2], /JSON object/],
    ];
    for (const [body, reason] of cases) {
      const r = await s.push(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(r.text, reason);
    }
    assert.equal(s.store.listSources().length, 0, "a refused message creates no source");
  } finally {
    await s.close();
    s.store.close();
  }
});

test("a non-JSON content type is 415 and a body over 2 MB is 413", async () => {
  const s = await serve();
  try {
    const wrongType = await s.call("POST", "/inbound/mail", { authorization: `Bearer ${s.token}`, "content-type": "text/plain" }, "hello");
    assert.equal(wrongType.status, 415);
    const big = await s.push({ ...ISSUE, text: "x".repeat(2 * 1024 * 1024 + 10) });
    assert.equal(big.status, 413);
    assert.equal(s.store.listSources().length, 0);
  } finally {
    await s.close();
    s.store.close();
  }
});

test("the door refuses another host and a web page's origin, like the rest of the server", async () => {
  const s = await serve();
  try {
    assert.equal((await s.push(ISSUE, { host: "evil.example" })).status, 403);
    assert.equal((await s.push(ISSUE, { origin: "https://evil.example" })).status, 403);
  } finally {
    await s.close();
    s.store.close();
  }
});

test("the 121st message inside a minute is 429, and the limit frees up a minute later", async () => {
  let now = NOW.getTime();
  const s = await serve(true, () => new Date(now));
  try {
    for (let i = 0; i < 120; i++) assert.equal((await s.push({ ...ISSUE, messageId: `<m${i}>` })).status, 201, `message ${i}`);
    assert.equal((await s.push({ ...ISSUE, messageId: "<over>" })).status, 429);
    now += 61_000;
    assert.equal((await s.push({ ...ISSUE, messageId: "<later>" })).status, 201);
  } finally {
    await s.close();
    s.store.close();
  }
});

test("a mail source is never due and a manual poll fetches nothing", async () => {
  const s = await serve();
  try {
    await s.push(ISSUE);
    const source = s.store.listSources()[0]!;
    assert.equal(s.store.dueSources(new Date(Date.now() + 10 * 86_400_000)).filter((x) => x.id === source.id).length, 0);
    const poll = await new Ingestor(s.store).pollSource(source);
    assert.equal(poll.status, "not-modified");
    assert.equal(poll.error, null);
  } finally {
    await s.close();
    s.store.close();
  }
});

test("the Connect screen API makes a token once, reports status, and clears it", async () => {
  const s = await serve(false);
  try {
    const before = JSON.parse((await s.call("GET", "/api/mail", {})).text);
    assert.deepEqual(before, { available: true, tokenSet: false, lastReceivedAt: null, receivedToday: 0 });
    const made = JSON.parse((await s.call("PUT", "/api/mail", {}, { token: "new" })).text);
    assert.match(made.token, /^jhm_/);
    assert.equal(made.tokenSet, true);
    const read = JSON.parse((await s.call("GET", "/api/mail", {})).text);
    assert.equal(read.tokenSet, true);
    assert.equal(read.token, undefined, "the token is shown once, never read back");
    assert.equal((await s.call("POST", "/inbound/mail", { authorization: `Bearer ${made.token}` }, ISSUE)).status, 201);
    const replaced = JSON.parse((await s.call("PUT", "/api/mail", {}, { token: "new" })).text);
    assert.equal((await s.call("POST", "/inbound/mail", { authorization: `Bearer ${made.token}` }, { ...ISSUE, messageId: "<again>" })).status, 401, "a replaced token stops working");
    assert.equal((await s.call("POST", "/inbound/mail", { authorization: `Bearer ${replaced.token}` }, { ...ISSUE, messageId: "<again>" })).status, 201);
    const cleared = JSON.parse((await s.call("PUT", "/api/mail", {}, { token: null })).text);
    assert.equal(cleared.tokenSet, false);
    assert.equal((await s.call("POST", "/inbound/mail", { authorization: `Bearer ${replaced.token}` }, ISSUE)).status, 404, "with no token the door is off again");
  } finally {
    await s.close();
    s.store.close();
  }
});

test("the view-in-browser finder takes only http(s) anchors whose words say web copy", () => {
  assert.equal(webVersionLink('<a href="https://a.example/x">Read online</a>'), "https://a.example/x");
  assert.equal(webVersionLink("<a href='http://a.example/y'>Having trouble? <b>View this email in your browser</b></a>"), "http://a.example/y");
  assert.equal(webVersionLink('<a href="https://a.example/w">Web version</a>'), "https://a.example/w");
  assert.equal(webVersionLink('<a href="https://a.example/z">Subscribe</a>'), "");
  assert.equal(webVersionLink('<a href="javascript:alert(1)">View in browser</a>'), "");
  assert.equal(webVersionLink('<a href="mailto:x@y.example">View in browser</a>'), "");
  assert.equal(webVersionLink("no links here"), "");
});

test("a message with only html is summarized from its text, and a missing subject falls back to the first line", async () => {
  const s = await serve();
  try {
    await s.push({ messageId: "<h1>", from: { address: "a@b.example" }, html: "<h1>Big news</h1><p>Details follow.</p>" });
    const item = s.store.listItems({})[0]!;
    assert.match(item.summaryText, /Big news/);
    assert.match(item.title, /Big news/);
    assert.equal(item.url, "");
  } finally {
    await s.close();
    s.store.close();
  }
});
