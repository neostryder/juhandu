import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./api/server.ts";
import type { AppDeps } from "./api/server.ts";
import { Ingestor } from "./ingest/ingest.ts";
import { buildEmbedder, buildProvider } from "./models/setup.ts";
import { Processor } from "./pipeline/process.ts";
import { StoryBuilder } from "./briefing/stories.ts";
import { Briefer } from "./briefing/briefer.ts";
import { McpAccess } from "./mcp/access.ts";
import { Notifier } from "./notify/notifier.ts";
import { PipeEngine } from "./pipes/engine.ts";
import { buildJudge } from "./judges/setup.ts";
import { ItemSummarizer } from "./summarize/summarizer.ts";
import { buildVideoReader } from "./video/setup.ts";
import { Proposer } from "./proposals/proposer.ts";
import { LearningAsk } from "./taste/ask.ts";
import { promoteDue } from "./taste/meter.ts";
import { Store } from "./store/store.ts";
import { buildSecretStore } from "./secrets/backends.ts";
import { AppSettings } from "./settings/settings.ts";
import { Credentials } from "./sources/credentials.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version: string }).version;

const host = process.env["JUHANDU_HOST"] ?? "127.0.0.1";
const port = Number(process.env["JUHANDU_PORT"] ?? process.env["PORT"] ?? 8787);
const dataDir = process.env["JUHANDU_DATA"] ?? join(root, "data");

const store = new Store(join(dataDir, "juhandu.sqlite"));
const secretSetup = buildSecretStore(process.env, dataDir);
const secrets = secretSetup.store;
for (const note of secretSetup.notes) console.warn(note);
console.log(`Secrets: ${await secrets.describe()}`);
if (!["127.0.0.1", "::1", "localhost"].includes(host)) console.warn(`Juhandu is listening on ${host}, not only on this machine, and it has no sign-in yet. Anyone who can reach it can read your feeds and replace feed logins. Put it behind a reverse proxy with authentication (for example Cloudflare Access) or keep JUHANDU_HOST on 127.0.0.1.`);
const ingestor = new Ingestor(store, fetch, () => new Date(), Math.random, new Credentials(secrets));

const mergeSimilarity = process.env["JUHANDU_MERGE_SIMILARITY"] ? Number(process.env["JUHANDU_MERGE_SIMILARITY"]) : undefined;

/** Everything built from the model and video settings. It is built again whenever the Connect screen saves a change, so no restart is needed. */
async function buildModels(env: Record<string, string | undefined>) {
  const provider = buildProvider(env, dataDir, secrets);
  const embedder = buildEmbedder(provider, env);
  const processor = new Processor(store, embedder);
  const videoReader = buildVideoReader(env, store, provider, secrets);
  const summarizer = provider?.capabilities.chat ? new ItemSummarizer(provider, store, () => new Date(), async () => (videoReader ? videoReader.anyReady() : false)) : null;
  const judgeSetup = buildJudge(env, { provider, log: (entry) => store.logJudgment(entry) });
  const judge = judgeSetup.judge;
  for (const note of judgeSetup.notes) console.warn(note);
  const stories = provider && judge && embedder ? new StoryBuilder({ store, provider, judge, tag: () => embedder.tag(), ...(mergeSimilarity ? { options: { similarity: mergeSimilarity } } : {}) }) : null;
  const proposer = new Proposer({ store, provider, embedder });
  const ask = new LearningAsk(store, embedder);
  return { provider, processor, videoReader, summarizer, judge, stories, proposer, ask };
}

let rewire = async (): Promise<void> => {};
const settings = new AppSettings({ store, secrets, env: process.env, dataDir, onChange: () => rewire() });
let models = await buildModels(await settings.effectiveEnv());
const briefer = new Briefer(store);
const pipes = new PipeEngine({ store, judge: models.judge });
const notifier = new Notifier({ store, secrets, getBriefing: (id) => briefer.get(id) ?? undefined });
const publicHosts = (process.env["JUHANDU_PUBLIC_HOST"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
const mcp = new McpAccess({ store, secrets });

/** One daily briefing is built each morning, once the hour has passed and no daily one exists for today (local time). */
function dailyBriefingDue(now: Date): boolean {
  const hour = Number(process.env["JUHANDU_BRIEFING_HOUR"] ?? 7);
  if (now.getHours() < hour) return false;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return !store.listBriefings(10).some((b) => b.kind === "daily" && Date.parse(b.createdAt) >= start);
}
const appDeps: AppDeps = { store, ingestor, secrets, processor: models.processor, briefer, pipes, proposer: models.proposer, ask: models.ask, notifier, mcp, settings, publicHosts, webRoot: join(root, "web"), version };
if (models.videoReader) appDeps.videoReader = models.videoReader;
if (models.summarizer) appDeps.summarizer = models.summarizer;
const server = createApp(appDeps);

rewire = async () => {
  models = await buildModels(await settings.effectiveEnv());
  appDeps.processor = models.processor;
  appDeps.proposer = models.proposer;
  appDeps.ask = models.ask;
  if (models.videoReader) appDeps.videoReader = models.videoReader;
  else delete appDeps.videoReader;
  if (models.summarizer) appDeps.summarizer = models.summarizer;
  else delete appDeps.summarizer;
  pipes.setJudge(models.judge);
  console.log(`Settings changed${models.provider ? `, local AI: ${models.provider.name}` : ", local AI off"}`);
  setTimeout(() => void tick(), 1_000);
  setTimeout(() => void readVideos(), 2_000);
};

let polling = false;
async function tick(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const results = await ingestor.pollDue();
    const inserted = results.reduce((sum, r) => sum + r.inserted, 0);
    if (results.length) console.log(`Polled ${results.length} sources, ${inserted} new items`);
    const { processor, summarizer, stories, proposer } = models;
    const processed = await processor.run();
    if (summarizer) {
      const summaries = await summarizer.run("background");
      if (summaries.summarized || summaries.failed) console.log(`Summarized ${summaries.summarized}, ${summaries.failed} failed, ${summaries.queued} waiting for a model`);
    }
    if (stories) {
      const merged = await stories.run("background");
      if (merged.merged || merged.storiesSummarized) console.log(`Checked ${merged.checked} items for shared stories, merged ${merged.merged}, wrote ${merged.storiesSummarized} story lines`);
    }
    const asked = await pipes.runAsks("background");
    if (asked.answered || asked.failed) console.log(`Answered ${asked.answered} questions for pipes, ${asked.failed} failed, ${asked.queued} waiting`);
    const proposed = await proposer.runIfVotesChanged("background");
    if (proposed?.proposed || proposed?.drafted) console.log(`Drafted ${proposed.drafted} rule suggestions from your votes, ${proposed.proposed} kept, ${proposed.rejected} dropped by the back-test`);
    for (const rule of promoteDue(store)) console.log(`Rule ${rule.id} met its bar and is now live`);
    if (dailyBriefingDue(new Date())) {
      const briefing = briefer.build({ kind: "daily" });
      console.log(`Built daily briefing ${briefing.id} with ${briefing.itemCount} unread items`);
    }
    const delivered = await notifier.deliverDue();
    if (delivered.sent || delivered.failed) console.log(`Briefing delivery: ${delivered.sent} sent, ${delivered.failed} failed or waiting to retry`);
    if (processed.embedded || processed.decided) console.log(`Embedded ${processed.embedded}, judged ${processed.decided}, ${processed.queued} waiting for a model`);
  } catch (error) {
    console.error("Polling failed:", error);
  } finally {
    polling = false;
  }
}

// Reading a video can take minutes, so it has its own loop and its own guard and never holds up polling.
let reading = false;
async function readVideos(): Promise<void> {
  const { videoReader } = models;
  if (!videoReader || reading) return;
  reading = true;
  try {
    const run = await videoReader.run(Number(process.env["JUHANDU_VIDEO_BATCH"] ?? 3));
    if (run.read || run.none || run.failed) console.log(`Read ${run.read} videos, ${run.none} could not be read, ${run.failed} failed and will be tried again, ${run.queued} waiting for a model`);
  } catch (error) {
    console.error("Reading videos failed:", error);
  } finally {
    reading = false;
  }
}

const timer = setInterval(() => void tick(), 60_000);
const videoTimer = setInterval(() => void readVideos(), 60_000);
setTimeout(() => void readVideos(), 10_000);
setTimeout(() => void tick(), 2_000);

server.listen(port, host, () => console.log(`Juhandu ${version} listening on http://${host}:${port}${models.provider ? `, local AI: ${models.provider.name}` : ", local AI off"}`));

function shutdown(): void {
  clearInterval(timer);
  clearInterval(videoTimer);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
