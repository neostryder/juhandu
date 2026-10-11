import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { EgressGate } from "../src/models/egress.ts";
import { NoEndpointError } from "../src/models/pool.ts";
import type { ChatRequest, ChatResult, ModelProvider } from "../src/models/provider.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Processor } from "../src/pipeline/process.ts";
import type { SecretStore } from "../src/secrets/store.ts";
import { ItemSummarizer } from "../src/summarize/summarizer.ts";
import { Store } from "../src/store/store.ts";
import type { NewItem } from "../src/store/store.ts";
import { CaptionsRung } from "../src/video/captions.ts";
import { ProgramFinder } from "../src/video/exec.ts";
import type { Command } from "../src/video/exec.ts";
import { GeminiUrlRung, orderModels } from "../src/video/gemini.ts";
import { youtubeVideoId } from "../src/video/ids.ts";
import { AppSideRung, mergeTimeline, parseTranscription } from "../src/video/local.ts";
import { VideoReader } from "../src/video/reader.ts";
import { cuesToTranscript, parseJson3, sampleText } from "../src/video/transcript.ts";
import { RungFailed, RungSkipped } from "../src/video/types.ts";
import type { VideoRung, VideoTarget } from "../src/video/types.ts";

const TARGET: VideoTarget = { itemId: 1, url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", videoId: "jNQXAC9IVRw", title: "Me at the zoo", tier: "public" };

function secretsWith(values: Record<string, string>): SecretStore {
  return { get: async (name: string) => values[name] } as unknown as SecretStore;
}

function json3(lines: [number, string][]): string {
  return JSON.stringify({ wireMagic: "pb3", events: lines.map(([t, text]) => ({ tStartMs: t, dDurationMs: 2000, segs: [{ utf8: text }] })) });
}

const SPOKEN = Array.from({ length: 30 }, (_, i): [number, string] => [i * 8000, `Sentence number ${i} about the elephants and why they have really long trunks.`]);

function fakeProvider(reply: (request: ChatRequest) => string | Error, seen: ChatRequest[] = []): ModelProvider {
  return {
    name: "fake",
    capabilities: { embed: false, chat: true, decide: false, transcribe: false },
    embeddingModel: async () => null,
    embed: async () => {
      throw new Error("no embeddings");
    },
    chat: async (request): Promise<ChatResult> => {
      seen.push(request);
      const out = reply(request);
      if (out instanceof Error) throw out;
      return { text: out, model: "fake-model" };
    },
    status: async () => ({ name: "fake", ok: true, detail: "", serves: [] }),
  };
}

const DIGEST = "Two sentences about elephants.\n00:08 - Elephants have long trunks";

function videoItem(guid: string, url: string, text = ""): NewItem {
  return { guid, url, title: `Video ${guid}`, author: "", publishedAt: "2026-10-07T08:00:00Z", summaryText: text, contentHtml: "", image: "", titleHash: guid, extra: {} };
}

async function storeWith(items: NewItem[], tier: "public" | "private" = "public"): Promise<Store> {
  const store = new Store(":memory:");
  const source = store.addSource({ kind: "feed", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCxxxxxxxxxxxxxxxxxxxxxx", tier });
  store.upsertItems(source.id, items);
  await new Processor(store, null).decidePending();
  return store;
}

function stubRung(id: string, behavior: "ok" | "fail" | "skip" | "unavailable" | "private-only" | "public-only", seen: string[] = []): VideoRung {
  return {
    id,
    label: id,
    appliesTo: (target) => (behavior === "private-only" ? target.tier === "private" : behavior === "public-only" ? target.tier === "public" : true),
    unavailable: async () => (behavior === "unavailable" ? "not set up" : null),
    read: async () => {
      seen.push(id);
      if (behavior === "fail") throw new RungFailed("could not");
      if (behavior === "skip") throw new RungSkipped("no key");
      return { text: `Reading from ${id}. ${"It covers elephants. ".repeat(10)}`, rung: id, model: `${id}-model` };
    },
  };
}

test("video addresses: watch, short, shorts and embed links give the id; anything else gives none", () => {
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw&t=4s"), "jNQXAC9IVRw");
  assert.equal(youtubeVideoId("https://youtu.be/jNQXAC9IVRw?si=abc"), "jNQXAC9IVRw");
  assert.equal(youtubeVideoId("https://www.youtube.com/shorts/jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(youtubeVideoId("https://www.youtube.com/embed/jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(youtubeVideoId("https://www.youtube.com/@someone"), null);
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=short"), null);
  assert.equal(youtubeVideoId("https://vimeo.com/12345"), null);
  assert.equal(youtubeVideoId("not a url"), null);
});

test("captions: rolling lines collapse, lines group by time, and long text is sampled from start to end", () => {
  const cues = parseJson3(json3([[0, "hello there"], [1000, "hello there"], [2000, "hello there everyone"], [4000, ""], [25000, "second part"]]));
  assert.deepEqual(cues.map((c) => c.text), ["hello there everyone", "second part"]);
  assert.equal(cuesToTranscript(cues), "[00:00] hello there everyone\n[00:25] second part");
  assert.deepEqual(parseJson3("not json"), []);
  const long = "a".repeat(1000) + "b".repeat(1000) + "c".repeat(1000);
  const sampled = sampleText(long, 600);
  assert.ok(sampled.startsWith("a") && sampled.endsWith("c") && sampled.includes("b"));
  assert.ok(sampled.length < 800);
});

test("Gemini models are ordered newest first with lite and special models last or out", () => {
  assert.deepEqual(
    orderModels(["models/gemini-3.6-flash", "models/gemini-3.8-flash", "models/gemini-3.8-flash-lite", "models/gemini-3.8-flash-image", "models/gemini-3.7-flash", "models/gemini-3.8-pro", "models/gemini-2.5-flash"]),
    ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-3.8-flash-lite"],
  );
});

test("the Gemini rung reads by address, moves past a busy model, and pauses when the key is refused", async () => {
  const calls: { url: string; body?: string }[] = [];
  let busy = new Set(["gemini-3.8-flash"]);
  let status = 200;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, ...(init?.body ? { body: String(init.body) } : {}) });
    if (url.includes("/models?")) return Response.json({ models: [{ name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }] });
    const model = url.match(/models\/([^:]+):/)?.[1] ?? "";
    if (status !== 200) return new Response("no", { status });
    if (busy.has(model)) return new Response("overloaded", { status: 503 });
    return Response.json({ candidates: [{ content: { parts: [{ text: "**Gist.** 00:10 - a point" }] } }] });
  };
  let now = 1_000_000;
  const rung = new GeminiUrlRung({ secrets: secretsWith({ gemini_api_key: "k-123456" }), env: {}, fetchImpl, clock: () => now });
  assert.equal(await rung.unavailable(), null);
  assert.equal(rung.appliesTo(TARGET), true);
  assert.equal(rung.appliesTo({ ...TARGET, tier: "private" }), false, "a private item never goes to a hosted service");
  const reading = await rung.read(TARGET);
  assert.equal(reading.model, "gemini-3.7-flash");
  assert.equal(reading.text, "Gist. 00:10 - a point");
  const body = JSON.parse(calls.at(-1)?.body ?? "{}") as { contents: { parts: { file_data?: { file_uri: string } }[] }[] };
  assert.equal(body.contents[0]?.parts[0]?.file_data?.file_uri, "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  assert.equal(calls.filter((c) => c.url.includes("/models?")).length, 1);
  await rung.read(TARGET);
  assert.equal(calls.filter((c) => c.url.includes("/models?")).length, 1, "the model list is remembered");
  busy = new Set(["gemini-3.8-flash", "gemini-3.7-flash"]);
  await assert.rejects(rung.read(TARGET), RungFailed);
  busy = new Set();
  status = 403;
  await assert.rejects(rung.read(TARGET), RungFailed, "a 403 on one video, with the key still good, fails that video only");
  assert.equal(await rung.unavailable(), null, "one restricted video does not pause the key");
  const refused = new GeminiUrlRung({ secrets: secretsWith({ gemini_api_key: "k-123456" }), env: {}, clock: () => now, fetchImpl: async (url: string) => (url.includes("/models?pageSize=1") ? new Response("no", { status: 403 }) : url.includes("/models?") ? Response.json({ models: [] }) : new Response("no", { status: 403 })) });
  await assert.rejects(refused.read(TARGET), RungSkipped, "a 403 that the key check repeats is a refused key");
  assert.match((await refused.unavailable()) ?? "", /Paused/);
  status = 401;
  await assert.rejects(rung.read(TARGET), RungSkipped);
  assert.match((await rung.unavailable()) ?? "", /Paused/);
  now += 3_700_000;
  assert.equal(await rung.unavailable(), null, "the pause ends after an hour");
  const invalid = new GeminiUrlRung({ secrets: secretsWith({ gemini_api_key: "k-bad" }), env: {}, clock: () => now, fetchImpl: async (url: string) => (url.includes("/models?") ? Response.json({ models: [] }) : Response.json({ error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, { status: 400 })) });
  await assert.rejects(invalid.read(TARGET), RungSkipped, "a key Google calls invalid is refused, not counted against the video");
  assert.match((await invalid.unavailable()) ?? "", /Paused/);
  assert.match((await new GeminiUrlRung({ secrets: secretsWith({}), env: {}, fetchImpl }).unavailable()) ?? "", /No Gemini key/);
  assert.equal(await new GeminiUrlRung({ secrets: secretsWith({}), env: { JUHANDU_GEMINI_KEY: "k-123456" }, fetchImpl }).unavailable(), null, "the environment names a key too");
});

test("the captions rung runs yt-dlp, reads the file it wrote, and digests it", async () => {
  const runs: { file: string; args: string[] }[] = [];
  const run: Command = async (file, args, options) => {
    runs.push({ file, args });
    if (args[0] === "--version") return { code: 0, stdout: "2026.08.19", stderr: "" };
    await writeFile(join(options?.cwd as string, "jNQXAC9IVRw.en.json3"), json3(SPOKEN));
    return { code: 1, stdout: "DURATION=240\n", stderr: "ERROR: HTTP Error 429 for the second track" };
  };
  const seen: ChatRequest[] = [];
  const rung = new CaptionsRung({ env: {}, provider: fakeProvider(() => DIGEST, seen), run });
  assert.equal(await rung.unavailable(), null);
  const reading = await rung.read(TARGET);
  assert.equal(reading.rung, "captions");
  assert.equal(reading.text, DIGEST);
  assert.equal(reading.durationSec, 240);
  assert.match(reading.transcript ?? "", /^\[00:00\] Sentence number 0/);
  const command = runs.find((r) => r.args.includes("--write-subs"));
  assert.ok(command?.args.includes("jNQXAC9IVRw") === false && command?.args.at(-1) === "https://www.youtube.com/watch?v=jNQXAC9IVRw");
  assert.match(seen[0]?.messages[1]?.content ?? "", /<transcript>/);
  assert.equal(seen[0]?.tier, "public");
  // Without a chat model the transcript's opening stands in for the digest.
  const plain = await new CaptionsRung({ env: {}, provider: null, run }).read(TARGET);
  assert.match(plain.text, /^Transcript: \[00:00\]/);
  assert.equal(plain.model, "transcript");
  // A model that is down leaves the video queued.
  await assert.rejects(new CaptionsRung({ env: {}, provider: fakeProvider(() => new NoEndpointError("down")), run }).read(TARGET), NoEndpointError);
});

test("the captions rung fails cleanly with no captions and skips when yt-dlp is missing", async () => {
  const empty: Command = async (_file, args) => (args[0] === "--version" ? { code: 0, stdout: "x", stderr: "" } : { code: 0, stdout: "DURATION=5", stderr: "WARNING: There are no subtitles for the requested languages" });
  await assert.rejects(new CaptionsRung({ env: {}, provider: null, run: empty }).read(TARGET), /No captions/);
  const missing: Command = async () => {
    throw new Error("spawn yt-dlp ENOENT");
  };
  const rung = new CaptionsRung({ env: {}, provider: null, run: missing });
  assert.match((await rung.unavailable()) ?? "", /yt-dlp is not installed/);
  await assert.rejects(rung.read(TARGET), RungSkipped);
});

test("the ladder tries rungs in order, hands over on failure, and stores the first reading", async () => {
  const store = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw")]);
  const seen: string[] = [];
  const reader = new VideoReader([stubRung("gemini", "fail", seen), stubRung("captions", "ok", seen), stubRung("local", "ok", seen)], store);
  const run = await reader.run();
  assert.deepEqual(run, { read: 1, none: 0, failed: 0, queued: 0 });
  assert.deepEqual(seen, ["gemini", "captions"]);
  const stored = store.getVideoReading(1);
  assert.equal(stored?.status, "ok");
  assert.equal(stored?.rung, "captions");
  assert.equal(store.itemsNeedingVideo(10).length, 0);
  assert.equal(store.listItems({}).find((i) => i.id === 1)?.video?.rung, "captions");
});

test("a private item skips hosted rungs; nothing set up leaves the backlog alone; a non-video address is marked none", async () => {
  const store = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw"), videoItem("b", "https://www.youtube.com/watch?x=1")], "private");
  const seen: string[] = [];
  assert.deepEqual(await new VideoReader([stubRung("gemini", "public-only", seen)], store).run(), { read: 0, none: 2, failed: 0, queued: 0 }, "the hosted rung is ready, but nothing applies, so both items count as none");
  assert.equal(store.getVideoReading(1)?.status, "none");
  assert.deepEqual(seen, []);
  assert.equal(store.getVideoReading(2)?.status, "none");
  assert.match(store.getVideoReading(2)?.note ?? "", /not a single YouTube video/);
  const fresh = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw")]);
  const idle = await new VideoReader([stubRung("gemini", "unavailable")], fresh).run();
  assert.deepEqual(idle, { read: 0, none: 0, failed: 0, queued: 0 });
  assert.equal(fresh.getVideoReading(1), undefined, "nothing was recorded, so adding a key later reaches this video");
  const local = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw")], "private");
  assert.equal((await new VideoReader([stubRung("gemini", "public-only"), stubRung("local", "private-only", seen)], local).run()).read, 1);
  assert.deepEqual(seen, ["local"]);
});

test("a failed reading is retried later, gives up after three tries, and a model that is down leaves it queued", async () => {
  const store = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw")]);
  let now = new Date("2026-10-07T12:00:00Z");
  const reader = new VideoReader([stubRung("captions", "fail")], store, () => now);
  assert.equal((await reader.run()).failed, 1);
  assert.equal(store.itemsNeedingVideo(10, now).length, 0, "not retried at once");
  now = new Date(now.getTime() + 21 * 60_000);
  assert.equal(store.itemsNeedingVideo(10, now).length, 1);
  await reader.run();
  now = new Date(now.getTime() + 21 * 60_000);
  await reader.run();
  now = new Date(now.getTime() + 21 * 60_000);
  assert.equal(store.itemsNeedingVideo(10, now).length, 0, "three failed tries is the limit");
  assert.equal(store.getVideoReading(1)?.attempts, 3);
  const down = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw")]);
  const sleeping: VideoRung = { ...stubRung("captions", "ok"), read: async () => { throw new NoEndpointError("down"); } };
  assert.deepEqual(await new VideoReader([sleeping], down).run(), { read: 0, none: 0, failed: 0, queued: 1 });
  assert.equal(down.getVideoReading(1), undefined);
});

test("the summarizer waits for a video's reading and uses it", async () => {
  const store = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw", "Short blurb"), videoItem("b", "https://x.example/post", "x".repeat(200))]);
  const seen: ChatRequest[] = [];
  const reply = () => JSON.stringify({ summary: "A video about elephants and their trunks.", evidence: "It covers elephants" });
  const waiting = new ItemSummarizer(fakeProvider(reply, seen), store, () => new Date(), async () => true);
  assert.equal((await waiting.run()).summarized, 1, "only the article goes ahead");
  assert.equal(seen.length, 1);
  await new VideoReader([stubRung("captions", "ok")], store).run();
  const after = await waiting.run();
  assert.equal(after.summarized, 1);
  assert.match(seen.at(-1)?.messages[1]?.content ?? "", /Reading from captions/);
  assert.equal(store.listItems({}).find((i) => i.id === 1)?.summary?.verified, true, "the evidence is checked against the reading");
  const idle = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw", "x".repeat(200))]);
  assert.equal((await new ItemSummarizer(fakeProvider(reply), idle).run()).summarized, 1, "with no reader the video is summarized from the feed text as before");
});

test("the app-side rung makes speech and frames with the outside programs, merges them, and respects the egress gate", async () => {
  const runs: string[][] = [];
  const run: Command = async (file, args, options) => {
    runs.push([file, ...args]);
    const cwd = options?.cwd as string;
    if (args[0] === "--version" || args[0] === "-version") return { code: 0, stdout: "ok", stderr: "" };
    if (file === "yt-dlp" && args.includes("--skip-download")) return { code: 0, stdout: "DURATION=120\n", stderr: "" };
    if (file === "yt-dlp" && args.includes("bestaudio")) await writeFile(join(cwd, "audio.webm"), "audio");
    else if (file === "yt-dlp") await writeFile(join(cwd, "clip.mp4"), "video");
    else if (args.includes("speech.mp3")) await writeFile(join(cwd, "speech.mp3"), "mp3");
    else for (let i = 1; i <= 2; i++) await writeFile(join(cwd, `frame-00${i}.jpg`), "jpg");
    return { code: 0, stdout: "", stderr: "" };
  };
  const posts: { url: string; headers: Record<string, string>; kind: string }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    posts.push({ url, headers: init?.headers as Record<string, string>, kind: init?.body instanceof FormData ? "form" : "json" });
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "hello", segments: [{ start: 3, text: "Welcome to the zoo." }, { start: 40, text: "These are elephants." }] });
    return Response.json({ choices: [{ message: { content: "A slide titled ELEPHANTS." } }] });
  };
  const hosted = { name: "transcription", baseUrl: "https://speech.example/v1", model: "whisper-1", apiKey: "sk-test-1234", local: false };
  const vision = { name: "vision", baseUrl: "http://127.0.0.1:9000/v1", model: "gemma", local: true };
  const seen: ChatRequest[] = [];
  const rung = new AppSideRung({ env: {}, provider: fakeProvider(() => DIGEST, seen), endpoints: { transcribe: hosted, vision, gate: new EgressGate() }, run, fetchImpl, finder: new ProgramFinder(run) });
  assert.equal(await rung.unavailable(), null);
  const reading = await rung.read(TARGET);
  assert.equal(reading.rung, "local");
  assert.equal(reading.durationSec, 120);
  assert.match(reading.transcript ?? "", /\[00:03\] Welcome to the zoo\./);
  assert.match(reading.transcript ?? "", /ON SCREEN: A slide titled ELEPHANTS\./);
  const speech = posts.find((p) => p.url.endsWith("/audio/transcriptions"));
  assert.equal(speech?.kind, "form");
  assert.equal(speech?.headers["authorization"], "Bearer sk-test-1234");
  assert.equal(speech?.headers["content-type"], undefined, "the form sets its own content type");
  assert.equal(posts.filter((p) => p.url.endsWith("/chat/completions")).length, 2);
  // A private video may not reach the hosted speech server; the local vision server alone still applies.
  const privateTarget = { ...TARGET, tier: "private" as const };
  posts.length = 0;
  const privateReading = await rung.read(privateTarget);
  assert.equal(posts.some((p) => p.url.startsWith("https://speech.example")), false);
  assert.doesNotMatch(privateReading.transcript ?? "", /Welcome/);
  const hostedOnly = new AppSideRung({ env: {}, provider: null, endpoints: { transcribe: hosted, vision: null, gate: new EgressGate() }, run, fetchImpl });
  assert.equal(hostedOnly.appliesTo(privateTarget), false);
  assert.equal(new AppSideRung({ env: {}, provider: null, endpoints: { transcribe: hosted, vision: null, gate: new EgressGate(["transcription"]) }, run, fetchImpl }).appliesTo(privateTarget), true, "named for the private tier");
});

test("the app-side rung refuses long videos and reports what is missing", async () => {
  const run: Command = async (file, args) => (args[0] === "--version" || args[0] === "-version" ? { code: 0, stdout: "ok", stderr: "" } : { code: 0, stdout: file === "yt-dlp" ? "DURATION=7200\n" : "", stderr: "" });
  const endpoint = { name: "transcription", baseUrl: "http://127.0.0.1:9/v1", model: "w", local: true };
  const rung = new AppSideRung({ env: {}, provider: null, endpoints: { transcribe: endpoint, vision: null, gate: new EgressGate() }, run });
  await assert.rejects(rung.read(TARGET), /120 minutes long/);
  const none = new AppSideRung({ env: {}, provider: null, endpoints: { transcribe: null, vision: null, gate: new EgressGate() }, run });
  assert.match((await none.unavailable()) ?? "", /No speech or vision server/);
  assert.deepEqual(parseTranscription({ text: " plain  words " }), [{ startSec: 0, text: "plain words" }]);
  assert.equal(mergeTimeline([{ startSec: 1, text: "a" }], [{ startSec: 0.5, text: "b" }]), "[00:00] ON SCREEN: b\n[00:01] a");
});

test("GET /api/video reports the rungs, the counts and the newest readings", async () => {
  const store = await storeWith([videoItem("a", "https://www.youtube.com/watch?v=jNQXAC9IVRw")]);
  const reader = new VideoReader([stubRung("gemini", "unavailable"), stubRung("captions", "ok")], store);
  const server = createApp({ store, ingestor: new Ingestor(store), webRoot: ".", version: "test", videoReader: reader });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const before = (await (await fetch(`${base}/api/video`)).json()) as { enabled: boolean; waiting: number; rungs: { id: string; ready: boolean; reason: string }[] };
    assert.equal(before.enabled, true);
    assert.equal(before.waiting, 1);
    assert.deepEqual(before.rungs.map((r) => [r.id, r.ready, r.reason]), [["gemini", false, "not set up"], ["captions", true, ""]]);
    await reader.run();
    const after = (await (await fetch(`${base}/api/video`)).json()) as { waiting: number; counts: { status: string; rung: string; count: number }[]; recent: { title: string; text: string }[] };
    assert.equal(after.waiting, 0);
    assert.deepEqual(after.counts, [{ status: "ok", rung: "captions", count: 1 }]);
    assert.equal(after.recent[0]?.title, "Video a");
    const items = (await (await fetch(`${base}/api/items?view=all`)).json()) as { items: { video: { rung: string } | null }[] };
    assert.equal(items.items[0]?.video?.rung, "captions");
  } finally {
    server.close();
  }
});
