import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { EnvBackend } from "../src/secrets/backends.ts";
import { SecretStore } from "../src/secrets/store.ts";
import type { SecretBackend } from "../src/secrets/store.ts";
import { placeOf, placeOfIp, UnknownHostError } from "../src/settings/address.ts";
import type { Resolver } from "../src/settings/address.ts";
import { probeChat, probeGemini, silentWav, greySquarePng } from "../src/settings/probe.ts";
import { AppSettings, SettingsError } from "../src/settings/settings.ts";
import { Store } from "../src/store/store.ts";
import { ProgramFinder } from "../src/video/exec.ts";

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

/** A made-up key, built from parts so secret scanners do not mistake it for a real one. */
const SECRET = ["sk", "test", "0123456789abcdef"].join("-");
const BAD_KEY = "AIza-wrong-key-for-the-test";

/** Names resolve to fixed addresses, so no test touches DNS. */
const resolve: Resolver = async (host) => {
  const table: Record<string, string[]> = { "models.example.com": ["203.0.113.10"], "nas.home.arpa": ["192.168.1.20"], "sneaky.example.com": ["203.0.113.11", "127.0.0.1"] };
  const found = table[host];
  if (!found) throw new Error("not found");
  return found;
};

/** No program is installed. */
const noPrograms = new ProgramFinder(async () => {
  throw new Error("not installed");
});

type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(answer: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return answer(call);
  };
  return { calls, impl: impl as typeof fetch };
}

function setup(env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch) {
  const store = new Store(":memory:");
  const mem = new MemBackend();
  const secrets = new SecretStore([new EnvBackend(env), mem]);
  let changes = 0;
  const settings = new AppSettings({ store, secrets, env, dataDir: ".", resolve, finder: noPrograms, container: false, onChange: async () => void changes++, ...(fetchImpl ? { fetchImpl } : {}) });
  return { store, mem, secrets, settings, changes: () => changes };
}

test("addresses are sorted into this machine, the owner's network and the internet", async () => {
  assert.equal(placeOfIp("127.0.0.1"), "this-machine");
  assert.equal(placeOfIp("::1"), "this-machine");
  assert.equal(placeOfIp("::ffff:10.0.0.1"), "own-network");
  assert.equal(placeOfIp("169.254.169.254"), "own-network", "cloud metadata counts as a private network");
  assert.equal(placeOfIp("100.100.1.1"), "own-network", "VPN ranges count as a private network");
  assert.equal(placeOfIp("fd00::1"), "own-network");
  assert.equal(placeOfIp("8.8.8.8"), "internet");
  assert.equal(await placeOf("http://localhost:8080/v1", resolve), "this-machine");
  assert.equal(await placeOf("http://models.example.com/v1", resolve), "internet");
  assert.equal(await placeOf("http://nas.home.arpa:11434/v1", resolve), "own-network");
  assert.equal(await placeOf("https://sneaky.example.com/v1", resolve), "this-machine", "a name with any local address counts as local");
  await assert.rejects(placeOf("http://nowhere.invalid/v1", resolve), UnknownHostError);
});

test("saved endpoint values fill the environment, and a variable that is set always wins", async () => {
  const first = setup();
  await first.settings.saveEndpoint("chat", { url: "https://models.example.com/v1/", model: "saved-model", key: SECRET });
  await first.settings.saveEndpoint("embed", { url: "https://models.example.com/v1", model: "bge-m3" });
  assert.equal(first.changes(), 2, "every save asks the server to rebuild its models");
  // The same saved settings, read by a server whose environment now sets the chat model.
  const env0 = { JUHANDU_CHAT_MODEL: "from-env" };
  const settings = new AppSettings({ store: first.store, secrets: new SecretStore([new EnvBackend(env0), first.mem]), env: env0, dataDir: ".", resolve, finder: noPrograms, container: false });
  await assert.rejects(settings.saveEndpoint("chat", { model: "other" }), (e: unknown) => e instanceof SettingsError && e.status === 409);
  const env = await settings.effectiveEnv();
  assert.equal(env["JUHANDU_CHAT_URL"], "https://models.example.com/v1", "the trailing slash is dropped");
  assert.equal(env["JUHANDU_CHAT_MODEL"], "from-env");
  assert.equal(env["JUHANDU_CHAT_KEY"], SECRET, "the stored key reaches the server's environment");
  assert.equal(env["JUHANDU_EMBED_TAG"], "bge-m3", "a saved embedding model names its own vectors");
  const view = await settings.status();
  const chat = view.endpoints.find((e) => e.id === "chat")!;
  assert.deepEqual(chat.url, { value: "https://models.example.com/v1", from: "saved", variable: "JUHANDU_CHAT_URL" });
  assert.equal(chat.model.from, "server");
  assert.equal(chat.model.value, "from-env");
  assert.equal(chat.key.set, true);
  assert.equal(chat.key.from, "saved");
  assert.ok(!JSON.stringify(view).includes(SECRET), "the key itself is never part of the status");
  assert.equal(view.host.active, "openai");
});

test("a value set by the server cannot be changed from the screen", async () => {
  const { settings } = setup({ JUHANDU_CHAT_URL: "http://127.0.0.1:9000/v1?token=abc", JUHANDU_GEMINI_KEY: "env-key", JUHANDU_SECRET_EMBED_KEY: "env-secret" });
  await assert.rejects(settings.saveEndpoint("chat", { url: "https://models.example.com/v1" }), (e: unknown) => e instanceof SettingsError && e.status === 409 && /JUHANDU_CHAT_URL/.test(e.message));
  await assert.rejects(settings.saveVideo({ geminiKey: "another" }), (e: unknown) => e instanceof SettingsError && e.status === 409);
  await assert.rejects(settings.saveEndpoint("embed", { key: "another" }), (e: unknown) => e instanceof SettingsError && e.status === 409 && /env secret store/.test(e.message));
  const view = await settings.status();
  const chat = view.endpoints.find((e) => e.id === "chat")!;
  assert.equal(chat.url.from, "server");
  assert.equal(chat.url.value, "http://127.0.0.1:9000/v1", "a query string that could hold a token is never shown");
  assert.equal(view.endpoints.find((e) => e.id === "embed")!.key.from, "server");
  assert.deepEqual(view.video.geminiKey, { set: true, from: "server", variable: "JUHANDU_GEMINI_KEY", secret: "gemini_api_key" });
});

test("an address on this machine or a private network needs a confirmation", async () => {
  const { settings } = setup();
  await assert.rejects(settings.saveEndpoint("chat", { url: "http://127.0.0.1:8080/v1" }), (e: unknown) => e instanceof SettingsError && e.status === 409 && e.code === "confirm-address" && e.place === "this-machine");
  await assert.rejects(settings.saveEndpoint("transcribe", { url: "http://nas.home.arpa:9000/v1" }), (e: unknown) => e instanceof SettingsError && e.code === "confirm-address" && e.place === "own-network");
  await assert.rejects(settings.saveEndpoint("chat", { url: "https://sneaky.example.com/v1" }), (e: unknown) => e instanceof SettingsError && e.place === "this-machine");
  await assert.rejects(settings.saveEndpoint("chat", { url: "http://nowhere.invalid/v1" }), (e: unknown) => e instanceof SettingsError && e.status === 422);
  await assert.rejects(settings.saveEndpoint("chat", { url: "file:///etc/passwd" }), (e: unknown) => e instanceof SettingsError && e.status === 422);
  await assert.rejects(settings.saveEndpoint("chat", { url: "https://user:pw@models.example.com/v1" }), /key field/);
  await settings.saveEndpoint("chat", { url: "http://127.0.0.1:8080/v1", confirmAddress: true });
  const chat = (await settings.status()).endpoints.find((e) => e.id === "chat")!;
  assert.equal(chat.url.value, "http://127.0.0.1:8080/v1");
  assert.equal(chat.local.value, true, "an address on this machine may take private items by default");
  await settings.saveEndpoint("chat", { url: "http://127.0.0.1:8080/v1", model: "qwen" });
  assert.equal((await settings.status()).endpoints.find((e) => e.id === "chat")!.model.value, "qwen", "saving the same address again needs no new confirmation");
});

test("keys are checked, stored, replaced and removed only in the secret store", async () => {
  const { settings, mem, store } = setup();
  await assert.rejects(settings.saveVideo({ geminiKey: "two words" }), /one line with no spaces/);
  await settings.saveVideo({ geminiKey: ` ${BAD_KEY} ` });
  assert.equal(mem.values.get("gemini_api_key"), BAD_KEY);
  assert.ok(!(store.getMeta("settings:connect") ?? "").includes(BAD_KEY), "no key is written to the database");
  mem.values.set("gemini/key", "older-name");
  await settings.saveVideo({ geminiKey: null });
  assert.equal(mem.values.has("gemini_api_key"), false);
  assert.equal(mem.values.has("gemini/key"), false, "removing the key removes the older name too");
  await settings.saveVideo({ enabled: false });
  assert.equal((await settings.effectiveEnv())["JUHANDU_VIDEO"], "off");
  assert.equal((await settings.status()).video.enabled.value, false);
});

test("the Test button turns a refused key into plain words and never repeats the key", async () => {
  const fake = fakeFetch((call) => {
    if (call.url.includes("generativelanguage")) return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }], message: `API key not valid: ${BAD_KEY}` } }, { status: 400 });
    return Response.json({ error: { message: `Incorrect API key provided: ${SECRET}` } }, { status: 401 });
  });
  const { settings } = setup({}, fake.impl);
  assert.deepEqual(await settings.testGemini(), { ok: false, message: "No Gemini key is saved yet. Paste one and save first." });
  await settings.saveVideo({ geminiKey: BAD_KEY });
  const gemini = await settings.testGemini();
  assert.equal(gemini.ok, false);
  assert.match(gemini.message, /not valid/);
  assert.ok(!gemini.message.includes(BAD_KEY));
  assert.equal((fake.calls[0]!.init!.headers as Record<string, string>)["x-goog-api-key"], BAD_KEY, "the key goes in a header, never in the address");
  assert.ok(!fake.calls[0]!.url.includes(BAD_KEY));
  await settings.saveEndpoint("chat", { url: "https://models.example.com/v1", key: SECRET });
  const chat = await settings.testEndpoint("chat");
  assert.deepEqual(chat, { ok: false, message: "The server refused the key. Check that it is the right one." });
  assert.equal((await settings.testEndpoint("vision")).ok, false);
});

test("the probes say what worked and what did not", async () => {
  const ok = fakeFetch(() => Response.json({ choices: [{ message: { content: "ok" } }] }));
  assert.deepEqual(await probeChat({ name: "chat", baseUrl: "https://m.example/v1", model: "m", local: false }, ok.impl), { ok: true, message: "The chat model m answered." });
  assert.equal(ok.calls[0]!.url, "https://m.example/v1/chat/completions");
  assert.equal(ok.calls[0]!.init!.redirect, "error", "a redirect is never followed somewhere else");
  const missing = fakeFetch(() => Response.json({ error: { code: "model_not_found" } }, { status: 404 }));
  assert.match((await probeChat({ name: "chat", baseUrl: "https://m.example/v1", model: "nope", local: false }, missing.impl)).message, /no model called nope/);
  const down = fakeFetch(() => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  assert.match((await probeChat({ name: "chat", baseUrl: "http://127.0.0.1:1/v1", model: "m", local: true }, down.impl)).message, /Nothing answered at 127\.0\.0\.1:1/);
  const good = fakeFetch(() => Response.json({ models: [] }));
  assert.deepEqual(await probeGemini("k", good.impl), { ok: true, message: "Google accepted the key." });
  assert.equal(silentWav().subarray(0, 4).toString(), "RIFF");
  assert.equal(greySquarePng().subarray(1, 4).toString(), "PNG");
});

// ---- over HTTP ----

function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c: Buffer) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the settings API keeps keys server side, asks before internal addresses and obeys the request guard", async () => {
  const { store, secrets, settings, mem } = setup();
  const app = createApp({ store, ingestor: new Ingestor(store), secrets, settings, webRoot: ".", version: "test" });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const port = (app.address() as AddressInfo).port;
  const json = { "content-type": "application/json" };
  try {
    const put = await call(port, "PUT", "/api/settings/endpoints/chat", json, JSON.stringify({ url: "https://models.example.com/v1", key: SECRET }));
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes(SECRET), "the saved key is not echoed");
    assert.equal(mem.values.get("chat/key"), SECRET);
    const get = await call(port, "GET", "/api/settings", {});
    assert.equal(get.status, 200);
    assert.ok(!get.text.includes(SECRET));
    assert.equal((JSON.parse(get.text) as { endpoints: { id: string; key: { set: boolean } }[] }).endpoints.find((e) => e.id === "chat")!.key.set, true);

    const local = await call(port, "PUT", "/api/settings/endpoints/vision", json, JSON.stringify({ url: "http://127.0.0.1:5000/v1" }));
    assert.equal(local.status, 409);
    assert.deepEqual(JSON.parse(local.text), { error: "That address points to this computer. Save it only if this server is yours.", code: "confirm-address", place: "this-machine" });
    assert.equal((await call(port, "PUT", "/api/settings/endpoints/vision", json, JSON.stringify({ url: "http://127.0.0.1:5000/v1", confirmAddress: true }))).status, 200);
    assert.equal((await call(port, "PUT", "/api/settings/endpoints/nope", json, "{}")).status, 404);

    assert.equal((await call(port, "PUT", "/api/settings/video", { "content-type": "text/plain" }, JSON.stringify({ enabled: false }))).status, 415, "a body that is not JSON is refused");
    assert.equal((await call(port, "PUT", "/api/settings/video", { ...json, origin: "https://evil.example" }, JSON.stringify({ enabled: false }))).status, 403, "another site cannot change settings");
    assert.equal((await call(port, "GET", "/api/settings", { host: "evil.example" })).status, 403, "a rebinding host cannot read settings");
    assert.equal((await call(port, "POST", "/api/settings/host/test", { ...json, origin: "https://evil.example" }, "{}")).status, 403);

    const setup1 = JSON.parse((await call(port, "GET", "/api/setup", {})).text) as { dismissed: boolean; steps: Record<string, boolean> };
    assert.deepEqual(setup1, { dismissed: false, steps: { feed: false, model: false, video: false, delivery: false } });
    assert.equal((await call(port, "PUT", "/api/setup", json, JSON.stringify({ dismissed: true }))).status, 200);
    assert.equal((JSON.parse((await call(port, "GET", "/api/setup", {})).text) as { dismissed: boolean }).dismissed, true);
    assert.equal((await call(port, "PUT", "/api/setup", json, JSON.stringify({ dismissed: "yes" }))).status, 400);
  } finally {
    await new Promise<void>((done) => app.close(() => done()));
    store.close();
  }
});
