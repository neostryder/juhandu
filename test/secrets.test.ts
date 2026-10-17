import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { BwsBackend, DirBackend, EnvBackend, OsBackend, buildSecretStore } from "../src/secrets/backends.ts";
import type { Run } from "../src/secrets/backends.ts";
import { envWithSecrets, keyFromSecrets } from "../src/secrets/env.ts";
import { Redactor, SecretStore, assertSecretName } from "../src/secrets/store.ts";
import type { SecretBackend } from "../src/secrets/store.ts";
import { buildProvider } from "../src/models/setup.ts";
import { Credentials, displayUrl, loginHeaders, maskUrl, parseLogin } from "../src/sources/credentials.ts";
import { fetchText } from "../src/sources/fetcher.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";
import { Store } from "../src/store/store.ts";

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Private Feed</title><link>https://private.example/</link>
<item><title>Secret story</title><link>https://private.example/a</link><guid>a</guid></item></channel></rss>`;

class MemBackend implements SecretBackend {
  readonly values = new Map<string, string>();
  fail = false;
  readonly id: string;
  readonly writable: boolean;
  constructor(id: string, writable = true) {
    this.id = id;
    this.writable = writable;
  }
  async available() {
    return true;
  }
  async get(name: string) {
    return this.values.get(name);
  }
  async set(name: string, value: string) {
    if (this.fail) throw new Error(`cannot write ${value}`);
    this.values.set(name, value);
  }
  async delete(name: string) {
    this.values.delete(name);
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "juhandu-secrets-"));
}

test("secret names are checked", () => {
  assert.doesNotThrow(() => assertSecretName("cogitator/interactive"));
  assert.doesNotThrow(() => assertSecretName("source/12"));
  for (const bad of ["", "Upper", "../x", "a//b", "a/", "-x", "a b", "x".repeat(121)]) assert.throws(() => assertSecretName(bad), bad);
});

test("the chain reads in order, writes to the first writable backend, and clears stale copies", async () => {
  const env = new MemBackend("env", false);
  const os = new MemBackend("os");
  const dir = new MemBackend("dir");
  const store = new SecretStore([env, os, dir], new Redactor());
  env.values.set("a/one", "from-env");
  os.values.set("a/one", "from-os");
  dir.values.set("a/two", "from-dir");
  assert.equal(await store.get("a/one"), "from-env", "env is read first");
  assert.equal(await store.get("a/two"), "from-dir", "later backends are still read");
  assert.equal(await store.get("a/none"), undefined);

  dir.values.set("a/three", "old-in-dir");
  assert.equal(await store.set("a/three", "new-value"), "os");
  assert.equal(os.values.get("a/three"), "new-value");
  assert.equal(dir.values.has("a/three"), false, "the stale copy in the other writable backend is removed");

  os.fail = true;
  assert.equal(await store.set("a/four", "fallback-value"), "dir", "a failing OS store falls back to the folder");
  await store.delete("a/four");
  assert.equal(dir.values.has("a/four"), false);
});

test("a write that fails everywhere reports an error without the value", async () => {
  const only = new MemBackend("os");
  only.fail = true;
  const store = new SecretStore([only], new Redactor());
  await assert.rejects(store.set("a/x", "super-secret-value"), (error: Error) => !error.message.includes("super-secret-value") && /Could not store/.test(error.message));
  await assert.rejects(new SecretStore([new MemBackend("env", false)], new Redactor()).set("a/x", "v-value"), /Could not store/);
});

test("the redactor removes values it has seen", async () => {
  const redact = new Redactor();
  const backend = new MemBackend("dir");
  const store = new SecretStore([backend], redact);
  await store.set("a/b", "tok-12345678");
  assert.equal(redact.apply("GET https://x/tok-12345678/feed failed"), "GET https://x/[secret]/feed failed");
  redact.add("abc");
  assert.equal(redact.apply("abc"), "abc", "values under six characters are not tracked");
});

test("the environment backend maps names and is read only", async () => {
  const env = new EnvBackend({ JUHANDU_SECRET_COGITATOR_INTERACTIVE: "k1" });
  assert.equal(await env.get("cogitator/interactive"), "k1");
  assert.equal(await env.get("cogitator/background"), undefined);
  await assert.rejects(env.set());
});

test("the folder backend stores one file per secret, reads older key files, and cleans up", async () => {
  const folder = tempDir();
  try {
    writeFileSync(join(folder, "interactive.key"), "legacy-key-value\n");
    const dir = new DirBackend(join(folder, "s"), {});
    const withAlias = new DirBackend(folder, { "cogitator/interactive": "interactive.key" });
    assert.equal(await withAlias.get("cogitator/interactive"), "legacy-key-value", "an older key file still works");
    await dir.set("source/12", '{"kind":"cookie"}');
    assert.equal(await dir.get("source/12"), '{"kind":"cookie"}');
    const files = readdirSync(join(folder, "s"));
    assert.deepEqual(files, ["s-source%2F12.secret"], "no temp file is left behind");
    if (process.platform !== "win32") assert.equal(statSync(join(folder, "s", files[0] as string)).mode & 0o077, 0, "owner-only permissions");
    await withAlias.set("cogitator/interactive", "new-key-value");
    assert.equal(await withAlias.get("cogitator/interactive"), "new-key-value", "a stored value beats the older file");
    await dir.delete("source/12");
    assert.equal(await dir.get("source/12"), undefined);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("deleting a secret removes its older key file, and a failing backend is reported", async () => {
  const folder = tempDir();
  try {
    writeFileSync(join(folder, "interactive.key"), "legacy-key-value" + String.fromCharCode(10));
    const withAlias = new DirBackend(folder, { "cogitator/interactive": "interactive.key" });
    await withAlias.delete("cogitator/interactive");
    assert.equal(await withAlias.get("cogitator/interactive"), undefined, "the older key file is gone too");
    const stuck: SecretBackend = { id: "stuck", writable: true, available: async () => true, get: async () => "x-value-stuck", set: async () => undefined, delete: async () => Promise.reject(new Error("denied")) };
    const good = new DirBackend(join(folder, "g"), {});
    await good.set("source/1", "kept-value-1");
    await assert.rejects(new SecretStore([stuck, good], new Redactor()).delete("source/1"), /Could not remove/);
    assert.equal(await good.get("source/1"), undefined, "the other backends were still cleared");
    const failing: Run = async () => ({ code: 5, stdout: "", stderr: "" });
    await assert.rejects(new OsBackend(failing, "linux").delete("source/2"), /libsecret delete failed/);
    await assert.rejects(new OsBackend(failing, "darwin").delete("source/2"), /Keychain delete failed/);
    const missing: Run = async () => ({ code: 44, stdout: "", stderr: "" });
    await new OsBackend(missing, "darwin").delete("source/2");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the Bitwarden backend needs a token and the bws tool, and looks secrets up by name", async () => {
  const calls: string[][] = [];
  const runner: Run = async (_file, args) => {
    calls.push(args);
    if (args[0] === "--version") return { code: 0, stdout: "bws 1.0", stderr: "" };
    return { code: 0, stdout: JSON.stringify([{ key: "JUHANDU_JEV_KEY", value: "bw-secret" }, { key: "source/3", value: "x-secret" }, { key: "other", value: 5 }, { key: "GEMINI_API_KEY", value: "gem-value" }]), stderr: "" };
  };
  assert.equal(await new BwsBackend({}, runner).available(), false, "no access token, not available");
  const bws = new BwsBackend({ BWS_ACCESS_TOKEN: "t", JUHANDU_BWS_PROJECT: "proj-1" }, runner);
  assert.equal(await bws.available(), true);
  assert.equal(await bws.get("jev/key"), "bw-secret", "the JUHANDU_ upper-case form is found");
  assert.equal(await bws.get("source/3"), "x-secret");
  assert.equal(await bws.get("gemini_api_key"), "gem-value", "the plain upper-case form is found too");
  assert.equal(calls.filter((c) => c[0] === "secret").length, 1, "the list is fetched once");
  assert.ok(calls.some((c) => c.includes("proj-1")));
  await assert.rejects(bws.set());
  const missing: Run = async () => {
    throw new Error("spawn ENOENT");
  };
  assert.equal(await new BwsBackend({ BWS_ACCESS_TOKEN: "t" }, missing).available(), false);
});

test("the OS backend never puts a value on a command line", async () => {
  const seen: { file: string; args: string[]; input: string }[] = [];
  const runner: Run = async (file, args, options) => {
    seen.push({ file, args, input: options?.input ?? "" });
    return { code: 0, stdout: "", stderr: "" };
  };
  const value = "very-secret-value";
  await new OsBackend(runner, "linux").set("source/5", value);
  await new OsBackend(runner, "darwin").set("source/5", value);
  await new OsBackend(runner, "win32").set("source/5", value);
  for (const call of seen) assert.equal(call.args.join(" ").includes(value), false, `${call.file} has no value in its arguments`);
  const [linux, mac, win] = seen;
  assert.equal(linux?.file, "secret-tool");
  assert.equal(linux?.input, value);
  assert.equal(mac?.file, "security");
  assert.ok(mac?.input.includes(Buffer.from(value).toString("hex")), "macOS gets the value as hex on stdin");
  assert.equal(Buffer.from(win?.input ?? "", "base64").toString("utf8"), value, "Windows gets the value as base64 on stdin");
});

test("the OS backend reads back, and a too-long value is refused for Credential Manager", async () => {
  const linux: Run = async (_f, args) => (args[0] === "lookup" ? { code: 0, stdout: "stored-value", stderr: "" } : { code: 1, stdout: "", stderr: "" });
  assert.equal(await new OsBackend(linux, "linux").get("a/b"), "stored-value");
  const win: Run = async (_f, _a, o) => ({ code: 0, stdout: Buffer.from("win-value").toString("base64"), stderr: o?.env?.["JUHANDU_CRED_OP"] ?? "" });
  assert.equal(await new OsBackend(win, "win32").get("a/b"), "win-value");
  await assert.rejects(new OsBackend(win, "win32").set("a/b", "x".repeat(2561)), /Too long/);
  const noTool: Run = async () => {
    throw new Error("spawn ENOENT");
  };
  assert.equal(await new OsBackend(noTool, "linux").available(), false);
  const noBus: Run = async () => ({ code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus" });
  assert.equal(await new OsBackend(noBus, "linux").available(), false);
});

test("buildSecretStore honours JUHANDU_SECRETS and reads the older Cogitator key files", async () => {
  const folder = tempDir();
  try {
    writeFileSync(join(folder, "background.key"), "bg-key-12345\n");
    const { store, notes } = buildSecretStore({ JUHANDU_SECRETS: "env,dir,nonsense", JUHANDU_SECRETS_DIR: folder, JUHANDU_SECRET_JEV_KEY: "jev-env-key" }, folder);
    assert.equal(notes.length, 1);
    assert.equal(await store.get("cogitator/background"), "bg-key-12345");
    assert.equal(await store.get("jev/key"), "jev-env-key");
    assert.equal((await store.status()).map((s) => s.id).join(), "env,dir");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("stored model keys fill the environment only when nothing else sets them", async () => {
  const mem = new MemBackend("dir");
  const store = new SecretStore([mem], new Redactor());
  mem.values.set("jev/key", "stored-jev");
  mem.values.set("chat/key", "stored-chat");
  const env = await envWithSecrets({ JUHANDU_CHAT_KEY: "from-env" }, store);
  assert.equal(env["JUHANDU_JEV_KEY"], "stored-jev");
  assert.equal(env["JUHANDU_CHAT_KEY"], "from-env");
  assert.equal((await envWithSecrets({ JEV_API_KEY: "x" }, store))["JUHANDU_JEV_KEY"], undefined, "an existing Jev setting wins");
  assert.equal(await keyFromSecrets(store, "jev/key").get(), "stored-jev");
  await assert.rejects(keyFromSecrets(store, "cogitator/interactive").get(), /No cogitator\/interactive key/);
});

test("Cogitator keys come from the SecretStore, and an env key file still wins", async () => {
  const folder = tempDir();
  try {
    const mem = new MemBackend("dir");
    const store = new SecretStore([mem], new Redactor());
    mem.values.set("cogitator/interactive", "interactive-from-store");
    const file = join(folder, "own.key");
    writeFileSync(file, "background-from-file\n");
    const provider = buildProvider({ JUHANDU_LOCAL_AI: "cogitator", JUHANDU_COGITATOR_URL: "http://127.0.0.1:1", JUHANDU_COGITATOR_BACKGROUND_KEY_FILE: file }, folder, store) as unknown as { opts?: unknown; options?: { interactiveKey: { get(): Promise<string> }; backgroundKey: { get(): Promise<string> } } };
    assert.ok(provider);
    const keys = Object.values(provider).find((v): v is { interactiveKey: { get(): Promise<string> }; backgroundKey: { get(): Promise<string> } } => typeof v === "object" && v !== null && "interactiveKey" in v);
    assert.ok(keys, "the provider keeps its key sources");
    assert.equal(await keys.interactiveKey.get(), "interactive-from-store");
    assert.equal(await keys.backgroundKey.get(), "background-from-file");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("logins are validated and turned into headers", () => {
  assert.deepEqual(loginHeaders(parseLogin({ kind: "basic", username: "ann", password: "pw" })), { authorization: `Basic ${Buffer.from("ann:pw").toString("base64")}` });
  assert.deepEqual(loginHeaders(parseLogin({ kind: "header", name: "X-Api-Key", value: "k" })), { "x-api-key": "k" });
  assert.deepEqual(loginHeaders(parseLogin({ kind: "cookie", cookie: "a=b" })), { cookie: "a=b" });
  assert.deepEqual(loginHeaders(parseLogin({ kind: "url", url: "https://x.example/f?t=1" })), {});
  for (const bad of [null, {}, { kind: "nope" }, { kind: "basic", username: "a" }, { kind: "header", name: "Host", value: "x" }, { kind: "header", name: "Cookie", value: "x" }, { kind: "header", name: "bad name", value: "x" }, { kind: "cookie", cookie: "a=b\r\nX: y" }, { kind: "url", url: "ftp://x" }]) {
    assert.throws(() => parseLogin(bad), JSON.stringify(bad));
  }
  const masked = maskUrl("https://private.example/feed/abc123?token=zzz");
  assert.equal(displayUrl(masked), "https://private.example/***");
  assert.equal(masked.includes("abc123") || masked.includes("zzz"), false);
  assert.notEqual(maskUrl("https://private.example/x"), maskUrl("https://private.example/x"), "markers differ so the unique column keeps both");
});

test("login headers go only to the original origin, including across redirects", async () => {
  const calls: { url: string; headers: Record<string, string>; redirect: string | undefined }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect });
    if (url === "https://a.example/start") return new Response(null, { status: 302, headers: { location: "/next" } });
    if (url === "https://a.example/next") return new Response(null, { status: 301, headers: { location: "https://b.example/elsewhere" } });
    return new Response(FEED, { status: 200 });
  };
  const result = await fetchText("https://a.example/start", {}, fetchImpl, 5000, { cookie: "s=1", authorization: "Basic abc" });
  assert.equal(result.finalUrl, "https://b.example/elsewhere");
  assert.equal(calls[0]?.headers["cookie"], "s=1");
  assert.equal(calls[1]?.headers["cookie"], "s=1", "a same-origin redirect keeps the login");
  assert.equal(calls[2]?.headers["cookie"], undefined, "a cross-origin redirect drops the cookie");
  assert.equal(calls[2]?.headers["authorization"], undefined);
  assert.ok(calls.every((c) => c.redirect === "manual"));

  calls.length = 0;
  await fetchText("https://a.example/plain", {}, fetchImpl);
  assert.equal(calls[0]?.redirect, "follow", "without a login the usual redirect handling is used");
});

interface Rig {
  base: string;
  store: Store;
  secrets: SecretStore;
  backend: MemBackend;
  folder: string;
  fetched: { url: string; headers: Record<string, string> }[];
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  close: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const folder = tempDir();
  const dbFile = join(folder, "j.sqlite");
  const store = new Store(dbFile);
  const backend = new MemBackend("dir");
  const secrets = new SecretStore([backend], new Redactor());
  const fetched: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetched.push({ url, headers });
    const ok = url.includes("tok-SECRET-123") || headers["authorization"] === `Basic ${Buffer.from("ann:hunter2-password").toString("base64")}` || headers["x-api-key"] === "key-SECRET-456" || headers["cookie"] === "sid=cookie-SECRET-789";
    return ok ? new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml" } }) : new Response("no", { status: 401 });
  };
  const server = createApp({ store, ingestor: new Ingestor(store, fetchImpl, () => new Date(), Math.random, new Credentials(secrets)), secrets, fetchImpl, webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    store,
    secrets,
    backend,
    folder,
    fetched,
    call: (method, path, body) => fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

function everyFileHolds(folder: string, needle: string): boolean {
  return readdirSync(folder).some((name) => readFileSync(join(folder, name)).includes(needle));
}

test("a feed behind basic login is added, polled with the login, and the password is only in the secret store", async () => {
  const r = await rig();
  try {
    const bad = await r.call("POST", "/api/sources", { url: "https://private.example/feed", login: { kind: "basic", username: "ann", password: "wrong-password" } });
    assert.equal(bad.status, 422, "a wrong login is rejected at the add");
    assert.equal(r.store.listSources().length, 0);

    const login = { kind: "basic", username: "ann", password: "hunter2-password" };
    const added = await r.call("POST", "/api/sources", { url: "https://private.example/feed", folder: "News", login });
    assert.equal(added.status, 201);
    const text = await added.text();
    assert.equal(text.includes("hunter2-password"), false, "the response never carries the password");
    const { source } = JSON.parse(text) as { source: { id: number; auth: string; url: string; title: string } };
    assert.equal(source.auth, "basic");
    assert.equal(source.title, "Private Feed");
    assert.deepEqual(await r.secrets.getJson(`source/${source.id}`), { kind: "basic", username: "ann", password: "hunter2-password" });

    const poll = await r.call("POST", `/api/sources/${source.id}/poll`);
    assert.equal(((await poll.json()) as { status: string }).status, "updated", "the poller sends the login");
    const listed = await (await r.call("GET", "/api/sources")).text();
    assert.equal(listed.includes("hunter2-password") || listed.includes("ann:"), false);

    assert.equal(everyFileHolds(r.folder, "hunter2-password"), false, "the password is not in any database file");
  } finally {
    await r.close();
  }
});

test("a private link keeps only a masked address in the database, fetches the real one, and is not added twice", async () => {
  const r = await rig();
  try {
    const link = "https://private.example/u/tok-SECRET-123/feed.xml";
    const added = await r.call("POST", "/api/sources", { login: { kind: "url", url: link } });
    assert.equal(added.status, 201);
    const { source } = (await added.json()) as { source: { id: number; auth: string; url: string } };
    assert.equal(source.auth, "url");
    assert.equal(source.url, "https://private.example/***", "the API shows the host only");
    assert.ok(r.store.getSource(source.id)?.url.startsWith("https://private.example/***#secret-"));
    assert.equal(r.store.getSource(source.id)?.url.includes("tok-SECRET-123"), false);
    assert.deepEqual(await r.secrets.getJson(`source/${source.id}`), { kind: "url", url: link });

    const again = await r.call("POST", "/api/sources", { login: { kind: "url", url: link } });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { alreadySubscribed?: boolean }).alreadySubscribed, true);
    assert.equal(r.store.listSources().length, 1);

    const poll = (await (await r.call("POST", `/api/sources/${source.id}/poll`)).json()) as { status: string };
    assert.equal(poll.status, "updated");
    assert.equal(r.fetched.at(-1)?.url, link, "the real address is what gets fetched");

    assert.equal(everyFileHolds(r.folder, "tok-SECRET-123"), false, "the token is not in any database file");
  } finally {
    await r.close();
  }
});

test("header and cookie logins work, and a login can be replaced or removed but not switched to a private link", async () => {
  const r = await rig();
  try {
    const header = (await (await r.call("POST", "/api/sources", { url: "https://private.example/h", login: { kind: "header", name: "X-Api-Key", value: "key-SECRET-456" } })).json()) as { source: { id: number; auth: string } };
    assert.equal(header.source.auth, "header");
    const cookie = (await (await r.call("POST", "/api/sources", { url: "https://private.example/c", login: { kind: "cookie", cookie: "sid=cookie-SECRET-789" } })).json()) as { source: { id: number; auth: string } };
    assert.equal(cookie.source.auth, "cookie");

    const replaced = await r.call("PUT", `/api/sources/${cookie.source.id}/login`, { login: { kind: "cookie", cookie: "sid=cookie-SECRET-789" } });
    assert.equal(replaced.status, 200);
    assert.equal(((await replaced.json()) as { source: { auth: string } }).source.auth, "cookie");
    assert.equal((await r.call("PUT", `/api/sources/${cookie.source.id}/login`, { login: { kind: "url", url: "https://x.example/y" } })).status, 422, "a header or cookie feed cannot become a private link");
    assert.equal((await r.call("PUT", `/api/sources/${cookie.source.id}/login`, { login: { kind: "basic", username: "" } })).status, 400);

    const removed = await r.call("DELETE", `/api/sources/${cookie.source.id}/login`);
    assert.equal(((await removed.json()) as { source: { auth: string | null } }).source.auth, null);
    assert.equal(await r.secrets.has(`source/${cookie.source.id}`), false);

    const gone = await r.call("DELETE", `/api/sources/${header.source.id}`);
    assert.equal(gone.status, 200);
    assert.equal(await r.secrets.has(`source/${header.source.id}`), false, "removing a feed removes its login");
  } finally {
    await r.close();
  }
});

test("a login that cannot be stored removes the feed again, and a missing secret shows as a fetch error without the secret", async () => {
  const r = await rig();
  try {
    r.backend.fail = true;
    const refused = await r.call("POST", "/api/sources", { url: "https://private.example/feed", login: { kind: "basic", username: "ann", password: "hunter2-password" } });
    assert.equal(refused.status, 500);
    assert.equal((await refused.text()).includes("hunter2-password"), false);
    assert.equal(r.store.listSources().length, 0, "no feed is left behind without its login");
    r.backend.fail = false;

    const added = (await (await r.call("POST", "/api/sources", { login: { kind: "url", url: "https://private.example/u/tok-SECRET-123/feed" } })).json()) as { source: { id: number } };
    await r.secrets.delete(`source/${added.source.id}`);
    const poll = (await (await r.call("POST", `/api/sources/${added.source.id}/poll`)).json()) as { status: string; error: string };
    assert.equal(poll.status, "error");
    assert.match(poll.error, /login for this feed is missing/);
  } finally {
    await r.close();
  }
});

test("errors from a private-link fetch do not repeat the token", async () => {
  const store = new Store(":memory:");
  const backend = new MemBackend("dir");
  const secrets = new SecretStore([backend], new Redactor());
  const credentials = new Credentials(secrets);
  const link = "https://private.example/u/tok-SECRET-123/feed";
  const source = store.addSource({ kind: "feed", url: "https://private.example/***#secret-aa", auth: "url" });
  await credentials.save(source.id, { kind: "url", url: link });
  const failing: FetchLike = async (url) => {
    throw new Error(`connect failed for ${url}`);
  };
  const ingestor = new Ingestor(store, failing, () => new Date(), Math.random, credentials);
  const result = await ingestor.pollSource(source);
  assert.equal(result.status, "error");
  assert.equal(result.error?.includes("tok-SECRET-123"), false);
  assert.equal(store.getSource(source.id)?.lastError?.includes("tok-SECRET-123"), false, "the stored error is redacted");
  store.close();
});
