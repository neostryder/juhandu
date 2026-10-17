import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Redactor, SecretStore } from "../src/secrets/store.ts";
import type { SecretBackend } from "../src/secrets/store.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";
import { Store } from "../src/store/store.ts";
import { OUT_OF_BAND, TraktAuthError, TraktClient, TraktHttpError, TraktNotConnected, TraktRateLimited, challengeFor, pkcePair } from "../src/watch/trakt.ts";
import { TmdbClient, parseProviders, providerNames, whereToWatch } from "../src/watch/tmdb.ts";
import { JUSTWATCH_CREDIT, TMDB_NOTICE, WatchService } from "../src/watch/watch.ts";

const START = Date.parse("2026-10-16T12:00:00Z");
const DAY = 86_400_000;

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

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

const providerAnswer = {
  results: {
    US: { link: "https://www.themoviedb.org/tv/1001/watch?locale=US", flatrate: [{ provider_id: 8, provider_name: "Netflix" }], rent: [{ provider_id: 2, provider_name: "Apple TV" }] },
    GB: { link: "https://www.themoviedb.org/tv/1001/watch?locale=GB", flatrate: [{ provider_id: 9, provider_name: "Prime Video" }] },
    ZZZ: { flatrate: [{ provider_id: 1, provider_name: "Bad country code" }] },
  },
};

function shows(count: number, from = 1) {
  return Array.from({ length: count }, (_, i) => {
    const id = from + i;
    return {
      show: { title: `Show ${id}`, year: 2020, ids: { trakt: id, slug: `show-${id}`, tmdb: 1000 + id, imdb: `tt${id}`, tvdb: 5 }, images: { poster: [`walter.trakt.tv/images/shows/${id}/poster.jpg`] }, status: "returning series", network: "HBO" },
      progress: { aired: 10, completed: 4, last_watched_at: "2026-10-10T00:00:00Z", next_episode: { season: 1, number: 5, title: "Five", first_aired: "2026-10-01T00:00:00Z", runtime: 50 } },
    };
  });
}

/** A fake of Trakt and TMDB. The token endpoint issues numbered tokens and the API accepts only the newest access token. */
class FakeWeb {
  readonly calls: Call[] = [];
  issued = 0;
  accepted = "";
  refuseTokens = false;
  pages: unknown[][] = [shows(2)];
  forceStatus = new Map<string, { status: number; headers?: Record<string, string> }>();
  tmdb = new Map<number, unknown>([[1001, providerAnswer]]);
  tmdbToken = "tmdb-token";
  tmdbCalls: number[] = [];

  tokenCalls(): Call[] {
    return this.calls.filter((c) => c.url.endsWith("/oauth/token"));
  }

  readonly fetch: FetchLike = async (url, init) => {
    const call: Call = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {} };
    this.calls.push(call);
    const parsed = new URL(url);
    if (parsed.hostname === "api.themoviedb.org") {
      const id = Number(parsed.pathname.split("/")[3]);
      this.tmdbCalls.push(id);
      if (call.headers.get("authorization") !== `Bearer ${this.tmdbToken}`) return new Response("{}", { status: 401 });
      const answer = this.tmdb.get(id);
      return answer ? new Response(JSON.stringify(answer), { status: 200 }) : new Response("{}", { status: 404 });
    }
    if (parsed.pathname === "/oauth/token") {
      if (this.refuseTokens) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      this.issued++;
      this.accepted = `access-${this.issued}`;
      return new Response(JSON.stringify({ access_token: this.accepted, refresh_token: `refresh-${this.issued}`, expires_in: 7_776_000, created_at: Math.floor(START / 1000) }), { status: 200 });
    }
    const forced = this.forceStatus.get(parsed.pathname);
    if (forced) return new Response("{}", { status: forced.status, headers: forced.headers });
    if (call.headers.get("authorization") !== `Bearer ${this.accepted}`) return new Response("{}", { status: 401 });
    if (parsed.pathname === "/users/settings") return new Response(JSON.stringify({ user: { username: "sam", vip: true } }), { status: 200 });
    if (parsed.pathname === "/sync/progress/up_next") {
      const page = Number(parsed.searchParams.get("page") ?? 1);
      return new Response(JSON.stringify(this.pages[page - 1] ?? []), { status: 200, headers: { "x-pagination-page-count": String(this.pages.length) } });
    }
    return new Response("{}", { status: 404 });
  };
}

function rig(options: { redirectUri?: string; tmdb?: boolean } = {}) {
  const web = new FakeWeb();
  const backend = new MemBackend();
  const secrets = new SecretStore([backend], new Redactor());
  let now = START;
  const trakt = new TraktClient({ clientId: () => "client-id-xyz", secrets, fetchImpl: web.fetch, clock: () => now });
  const tmdb = options.tmdb === false ? null : new TmdbClient({ token: () => "tmdb-token", fetchImpl: web.fetch });
  const store = new Store(":memory:");
  const watch = new WatchService({ store, trakt, tmdb, redirectUri: options.redirectUri, clock: () => new Date(now), random: (size) => Buffer.alloc(size, 7) });
  return {
    web,
    backend,
    trakt,
    tmdb,
    store,
    watch,
    advance(ms: number) {
      now += ms;
    },
    async signIn() {
      const { state } = watch.start();
      await watch.finish("the-code", state);
    },
  };
}

test("the challenge matches the RFC 7636 example and a verifier is long enough", () => {
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(challenge, challengeFor(verifier));
});

test("the authorize address carries the client id, the redirect, the state and an S256 challenge, and no secret", () => {
  const { trakt } = rig();
  const url = new URL(trakt.authorizeUrl(OUT_OF_BAND, "st", "chal"));
  assert.equal(url.origin + url.pathname, "https://auth.trakt.tv/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-id-xyz");
  assert.equal(url.searchParams.get("redirect_uri"), OUT_OF_BAND);
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("code_challenge"), "chal");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.ok(![...url.searchParams.keys()].some((k) => k.includes("secret")));
});

test("a code is traded for tokens with the verifier and no client secret, and the tokens are saved as a secret", async () => {
  const { trakt, web, backend } = rig();
  assert.equal(await trakt.connected(), false);
  await trakt.exchange("abc", "verifier-1", OUT_OF_BAND);
  const [call] = web.tokenCalls();
  assert.equal(call!.body["code"], "abc");
  assert.equal(call!.body["code_verifier"], "verifier-1");
  assert.equal(call!.body["grant_type"], "authorization_code");
  assert.equal(call!.body["client_id"], "client-id-xyz");
  assert.ok(!("client_secret" in call!.body));
  assert.equal(await trakt.connected(), true);
  assert.equal(JSON.parse(backend.values.get("trakt/tokens")!).accessToken, "access-1");
  await trakt.disconnect();
  assert.equal(await trakt.connected(), false);
});

test("an expired token is renewed once even when two calls start together, and the new one is used", async () => {
  const { trakt, web, advance } = rig();
  await trakt.exchange("abc", "v", OUT_OF_BAND);
  advance(90 * DAY);
  const [a, b] = await Promise.all([trakt.account(), trakt.account()]);
  assert.deepEqual(a, { username: "sam", vip: true });
  assert.deepEqual(b, a);
  const refreshes = web.tokenCalls().filter((c) => c.body["grant_type"] === "refresh_token");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0]!.body["refresh_token"], "refresh-1");
  assert.ok(!("client_secret" in refreshes[0]!.body));
});

test("a 401 renews the token and retries once; a 401 that persists asks for a new sign-in", async () => {
  const { trakt, web } = rig();
  await trakt.exchange("abc", "v", OUT_OF_BAND);
  // Trakt revoked the access token early: the renewal hands out a new one and the call goes through.
  web.accepted = "revoked-elsewhere";
  assert.deepEqual(await trakt.account(), { username: "sam", vip: true });
  assert.equal(web.tokenCalls().filter((c) => c.body["grant_type"] === "refresh_token").length, 1);
  // A 401 that survives the renewal is not retried again.
  web.forceStatus.set("/users/settings", { status: 401 });
  await assert.rejects(trakt.account(), (error: Error) => error instanceof TraktAuthError && /Connect again/.test(error.message));
});

test("a refused renewal disconnects, and the failure says to connect again without echoing tokens", async () => {
  const { trakt, web, advance } = rig();
  await trakt.exchange("abc", "v", OUT_OF_BAND);
  advance(90 * DAY);
  web.refuseTokens = true;
  await assert.rejects(trakt.account(), (error: Error) => error instanceof TraktAuthError && /Connect again/.test(error.message) && !/refresh-1|access-1/.test(error.message));
  assert.equal(await trakt.connected(), false);
  await assert.rejects(trakt.account(), TraktNotConnected);
});

test("rate limits and the VIP answer map to their own errors", async () => {
  const { trakt, web } = rig();
  await trakt.exchange("abc", "v", OUT_OF_BAND);
  web.forceStatus.set("/users/settings", { status: 429, headers: { "retry-after": "17" } });
  await assert.rejects(trakt.account(), (error: unknown) => error instanceof TraktRateLimited && error.retryAfterSeconds === 17);
  web.forceStatus.set("/users/settings", { status: 426 });
  await assert.rejects(trakt.account(), (error: unknown) => error instanceof TraktHttpError && error.status === 426 && /VIP/.test(error.message));
  web.forceStatus.set("/users/settings", { status: 503 });
  await assert.rejects(trakt.account(), (error: unknown) => error instanceof TraktHttpError && error.status === 503);
});

test("up next reads every page and sends the headers Trakt requires", async () => {
  const { trakt, web } = rig();
  await trakt.exchange("abc", "v", OUT_OF_BAND);
  web.pages = [shows(2, 1), shows(2, 3), shows(1, 5)];
  const all = await trakt.upNext(2);
  assert.deepEqual(all.map((s) => s.show.ids.trakt), [1, 2, 3, 4, 5]);
  const last = web.calls.at(-1)!;
  assert.equal(last.headers.get("trakt-api-key"), "client-id-xyz");
  assert.equal(last.headers.get("trakt-api-version"), "2");
  assert.equal(last.headers.get("authorization"), "Bearer access-1");
  assert.match(last.url, /extended=full%2Cimages/);
});

test("TMDB answers are cut down to valid countries with offers, and a missing title is empty", async () => {
  const map = parseProviders(providerAnswer);
  assert.deepEqual(Object.keys(map).sort(), ["GB", "US"]);
  assert.equal(map["US"]!.rent[0]!.name, "Apple TV");
  assert.equal(parseProviders({ results: { US: { link: "http://insecure.example", ads: [{ provider_id: 1, provider_name: "Pluto" }] } } })["US"]!.link, "");
  assert.deepEqual(parseProviders(null), {});
  const { tmdb } = rig();
  assert.deepEqual(await tmdb!.watchProviders("tv", 999), {});
  await assert.rejects(new TmdbClient({ token: () => "wrong", fetchImpl: rig().web.fetch }).watchProviders("tv", 1001), /refused the read token/);
  await assert.rejects(new TmdbClient({ token: () => undefined }).watchProviders("tv", 1), /No TMDB read token/);
});

test("where to watch puts the person's services first, ignores case, and lists other countries", () => {
  const map = parseProviders(providerAnswer);
  const where = whereToWatch(map, "US", ["netflix"]);
  assert.deepEqual(where.mine, [{ name: "Netflix", kind: "flatrate" }]);
  assert.deepEqual(where.home, [{ name: "Apple TV", kind: "rent" }]);
  assert.deepEqual(where.elsewhere, [{ country: "GB", providers: ["Prime Video"], mine: [] }]);
  assert.equal(where.link, "https://www.themoviedb.org/tv/1001/watch?locale=US");
  const gb = whereToWatch(map, "GB", ["Netflix"]);
  assert.deepEqual(gb.elsewhere[0], { country: "US", providers: ["Netflix"], mine: ["Netflix"] });
  // Renting is never counted as one of the person's services.
  assert.deepEqual(whereToWatch(map, "US", ["Apple TV"]).mine, []);
  assert.deepEqual(providerNames([map], "US"), ["Netflix"]);
});

test("a sign-in state works once, expires, and the code goes back with its own verifier", async () => {
  const { watch, web, advance } = rig();
  const first = watch.start();
  assert.equal(first.manualCode, true);
  const challenge = new URL(first.url).searchParams.get("code_challenge")!;
  await watch.finish("the-code", first.state);
  const exchange = web.tokenCalls()[0]!;
  assert.equal(challengeFor(exchange.body["code_verifier"]), challenge);
  await assert.rejects(watch.finish("the-code", first.state), /expired/);
  await assert.rejects(watch.finish("x", "never-issued"), TraktAuthError);
  const late = watch.start();
  advance(16 * 60_000);
  await assert.rejects(watch.finish("the-code", late.state), /expired/);
});

test("with a web address of its own, sign-in comes back by itself instead of asking for a pasted code", () => {
  const { watch } = rig({ redirectUri: "https://juhandu.example/api/watch/callback" });
  const started = watch.start();
  assert.equal(started.manualCode, false);
  assert.equal(new URL(started.url).searchParams.get("redirect_uri"), "https://juhandu.example/api/watch/callback");
});

test("a sync stores the list, keeps only Trakt's own poster hosts, and caches availability", async () => {
  const r = rig();
  r.web.pages = [shows(2)];
  const odd = shows(1, 3);
  odd[0]!.show.images = { poster: ["https://evil.example/p.jpg"] };
  r.web.pages = [[...shows(2), ...odd]];
  await r.signIn();
  const result = await r.watch.sync();
  assert.deepEqual(result, { shows: 3, providers: 3 });
  const view = r.watch.upNext();
  assert.deepEqual(view.map((v) => v.title), ["Show 1", "Show 2", "Show 3"]);
  assert.equal(view[0]!.poster, "https://walter.trakt.tv/images/shows/1/poster.jpg");
  assert.equal(view[2]!.poster, "");
  assert.equal(view[0]!.traktUrl, "https://trakt.tv/shows/show-1");
  assert.deepEqual(view[0]!.availability, { state: "aired", msUntil: 0 });
  assert.equal(view[0]!.next!.title, "Five");
  assert.equal(view[0]!.where!.home.length + view[0]!.where!.mine.length, 2);
  // A show TMDB does not know is cached as an empty answer, so it is not asked again.
  assert.deepEqual(r.web.tmdbCalls.sort(), [1001, 1002, 1003]);
  assert.equal(view[1]!.where !== null, true);
  const status = await r.watch.status();
  assert.equal(status.connected, true);
  assert.equal(status.username, "sam");
  assert.equal(status.vip, true);
  assert.equal(status.lastError, "");
  assert.equal(status.lastSyncAt, new Date(START).toISOString());
  assert.deepEqual(status.attribution, [TMDB_NOTICE, JUSTWATCH_CREDIT]);
  assert.deepEqual(status.providerChoices, ["Netflix"]);
});

test("an upcoming episode counts down, and one with no air date is unknown", async () => {
  const r = rig();
  const list = shows(2);
  list[0]!.progress.next_episode.first_aired = new Date(START + 3 * 3_600_000).toISOString();
  (list[1]!.progress.next_episode as { first_aired: string | null }).first_aired = null;
  r.web.pages = [list];
  await r.signIn();
  await r.watch.sync();
  const view = r.watch.upNext();
  assert.deepEqual(view[0]!.availability, { state: "upcoming", msUntil: 3 * 3_600_000 });
  assert.deepEqual(view[1]!.availability, { state: "unknown", msUntil: 0 });
});

test("availability is looked up again only after three days, and anything older than 150 days is deleted", async () => {
  const r = rig();
  r.web.pages = [shows(1)];
  await r.signIn();
  await r.watch.sync();
  await r.watch.sync();
  assert.equal(r.web.tmdbCalls.length, 1, "a second sync within the refresh window asks nothing");
  r.advance(4 * DAY);
  await r.watch.sync();
  assert.equal(r.web.tmdbCalls.length, 2, "after three days it is refreshed");
  r.store.saveProviderCache("tv", 5, "{}", new Date(START - 200 * DAY));
  r.advance(1000);
  await r.watch.sync();
  assert.equal(r.store.getProviderCache("tv", 5), undefined);
});

test("at most 25 availability lookups run per sync, and a refused TMDB token stops the rest", async () => {
  const r = rig();
  r.web.pages = [shows(30)];
  await r.signIn();
  assert.equal((await r.watch.sync()).providers, 25);
  assert.equal(r.web.tmdbCalls.length, 25);
  assert.equal((await r.watch.sync()).providers, 5);
  const bad = rig();
  bad.web.tmdbToken = "something-else";
  bad.web.pages = [shows(10)];
  await bad.signIn();
  assert.equal((await bad.watch.sync()).providers, 0);
  assert.equal(bad.web.tmdbCalls.length, 1, "it stops after the first refusal");
});

test("without a TMDB token the list still syncs and no attribution is shown", async () => {
  const r = rig({ tmdb: false });
  await r.signIn();
  assert.deepEqual(await r.watch.sync(), { shows: 2, providers: 0 });
  assert.equal(r.watch.upNext()[0]!.where, null);
  const status = await r.watch.status();
  assert.equal(status.tmdbConfigured, false);
  assert.deepEqual(status.attribution, []);
});

test("a failed sync keeps the old list and records a short error with no token in it", async () => {
  const r = rig();
  await r.signIn();
  await r.watch.sync();
  r.web.forceStatus.set("/sync/progress/up_next", { status: 426 });
  await assert.rejects(r.watch.sync(), TraktHttpError);
  assert.equal(r.watch.upNext().length, 2);
  const status = await r.watch.status();
  assert.match(status.lastError, /VIP/);
  assert.ok(!/access-|refresh-/.test(status.lastError));
});

test("calls made during a sync share it", async () => {
  const r = rig();
  await r.signIn();
  const before = r.web.calls.length;
  await Promise.all([r.watch.sync(), r.watch.sync(), r.watch.sync()]);
  assert.equal(r.web.calls.slice(before).filter((c) => c.url.includes("/users/settings")).length, 1);
});

test("region and services are validated and remembered", async () => {
  const r = rig();
  assert.equal(r.watch.region(), "US");
  r.watch.saveSettings({ region: "gb", services: [" Netflix ", "Netflix", "", "Max"] });
  assert.equal(r.watch.region(), "GB");
  assert.deepEqual(r.watch.services(), ["Netflix", "Max"]);
  assert.throws(() => r.watch.saveSettings({ region: "GBR" }), RangeError);
  assert.throws(() => r.watch.saveSettings({ region: 5 }), RangeError);
  assert.throws(() => r.watch.saveSettings({ services: "Netflix" }), RangeError);
  assert.throws(() => r.watch.saveSettings({ services: [1] }), RangeError);
  assert.equal(r.watch.region(), "GB", "a refused change leaves the saved value alone");
  r.watch.saveSettings({ services: [] });
  assert.deepEqual(r.watch.services(), []);
});

test("disconnecting drops the sign-in, the local list and the saved account, and keeps the region", async () => {
  const r = rig();
  await r.signIn();
  r.watch.saveSettings({ region: "CA" });
  await r.watch.sync();
  await r.watch.disconnect();
  const status = await r.watch.status();
  assert.equal(status.connected, false);
  assert.equal(status.username, "");
  assert.equal(status.lastSyncAt === null || status.lastSyncAt === "", true);
  assert.equal(r.watch.upNext().length, 0);
  assert.equal(r.store.allProviderPayloads("tv").length, 0);
  assert.equal(r.backend.values.has("trakt/tokens"), false);
  assert.equal(status.region, "CA");
});

test("the Watch API signs in, syncs, saves settings and signs out, and refuses what it should", async () => {
  const r = rig({ redirectUri: "https://juhandu.example/api/watch/callback" });
  const server = createApp({ store: r.store, ingestor: new Ingestor(r.store), webRoot: ".", version: "test", watch: r.watch });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    return { status: response.status, location: response.headers.get("location"), body: text ? (JSON.parse(text) as Record<string, any>) : {} };
  };
  try {
    assert.equal((await call("POST", "/api/watch/sync")).status, 409, "syncing before signing in says so");
    assert.equal((await call("GET", "/api/watch")).body["connected"], false);
    const started = await call("POST", "/api/watch/connect");
    assert.equal(started.status, 200);
    assert.match(started.body["url"], /^https:\/\/auth\.trakt\.tv\/oauth\/authorize\?/);
    assert.equal(started.body["manualCode"], false);
    const back = await call("GET", `/api/watch/callback?code=abc&state=${started.body["state"]}`);
    assert.equal(back.status, 302);
    assert.equal(back.location, "/#/watch");
    assert.equal((await call("GET", "/api/watch/callback?code=abc&state=reused")).location, "/#/watch/denied");
    assert.equal((await call("GET", "/api/watch/callback?error=access_denied")).location, "/#/watch/denied");
    await r.watch.sync();
    const list = await call("GET", "/api/watch/up-next");
    assert.equal(list.body["items"].length, 2);
    assert.equal((await call("PUT", "/api/watch/settings", { region: "gb", services: ["Prime Video"] })).body["region"], "GB");
    assert.equal((await call("PUT", "/api/watch/settings", { region: "nope" })).status, 422);
    const synced = await call("POST", "/api/watch/sync");
    assert.equal(synced.status, 200);
    assert.equal(synced.body["shows"], 2);
    assert.equal(synced.body["items"][0].where.mine[0].name, "Prime Video");
    assert.equal((await call("POST", "/api/watch/connect/finish", { code: "", state: "x" })).status, 400);
    const finish = await call("POST", "/api/watch/connect/finish", { code: "abc", state: "never-issued" });
    assert.equal(finish.status, 400);
    assert.ok(!JSON.stringify(finish.body).includes("access-"));
    const out = await call("DELETE", "/api/watch/connect");
    assert.equal(out.body["connected"], false);
    assert.equal((await call("GET", "/api/watch/up-next")).body["items"].length, 0);
    r.web.forceStatus.set("/users/settings", { status: 429, headers: { "retry-after": "5" } });
    await r.signIn();
    assert.equal((await call("POST", "/api/watch/sync")).status, 429);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    r.store.close();
  }
});

test("Watch answers 503 when the server was started without it, and 503 to a sign-in with no client id", async () => {
  const store = new Store(":memory:");
  const bare = createApp({ store, ingestor: new Ingestor(store), webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/watch`);
    assert.equal(response.status, 503);
  } finally {
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  }
  const web = new FakeWeb();
  const trakt = new TraktClient({ clientId: () => undefined, secrets: new SecretStore([new MemBackend()], new Redactor()), fetchImpl: web.fetch });
  const watch = new WatchService({ store, trakt, tmdb: null });
  const server = createApp({ store, ingestor: new Ingestor(store), webRoot: ".", version: "test", watch });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal(((await (await fetch(base + "/api/watch")).json()) as Record<string, unknown>)["traktConfigured"], false);
    assert.equal((await fetch(base + "/api/watch/connect", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
