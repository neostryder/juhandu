import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Ingestor } from "../ingest/ingest.ts";
import { toNewItem } from "../ingest/ingest.ts";
import type { FetchLike } from "../sources/fetcher.ts";
import type { Processor } from "../pipeline/process.ts";
import { MAX_LIST_ENTRIES, parseList, planImport, previewList } from "../rules/blocklist.ts";
import type { ListFormat } from "../rules/blocklist.ts";
import { validateCondition } from "../rules/rules.ts";
import type { RuleCondition, RuleKind, RuleScope, RuleStatus } from "../rules/rules.ts";
import { RequestGuard } from "./guard.ts";
import { importOpml, previewOpml } from "../import/opml.ts";
import { PipeEngine } from "../pipes/engine.ts";
import { renderAtom } from "../pipes/feed.ts";
import { parsePipeDoc, slugify } from "../pipes/pipe.ts";
import type { StoredPipe } from "../store/store.ts";
import { resolveSource } from "../sources/resolve.ts";
import { Credentials, displayUrl, loginHeaders, maskUrl, parseLogin } from "../sources/credentials.ts";
import type { Login } from "../sources/credentials.ts";
import type { SecretStore } from "../secrets/store.ts";
import { NoEndpointError } from "../models/pool.ts";
import { Briefer, renderMarkdown } from "../briefing/briefer.ts";
import type { BriefingKind } from "../briefing/briefer.ts";
import type { ItemSummarizer } from "../summarize/summarizer.ts";
import type { VideoReader } from "../video/reader.ts";
import type { RungStatus } from "../video/types.ts";
import type { DataTier, ItemView, NewRule, Proposal, Source, Store } from "../store/store.ts";
import type { Proposer } from "../proposals/proposer.ts";
import type { LearningAsk } from "../taste/ask.ts";
import { ruleMeters } from "../taste/meter.ts";
import { CHANNELS, NotifyError } from "../notify/notifier.ts";
import type { ChannelId, Notifier } from "../notify/notifier.ts";
import { McpServer } from "../mcp/server.ts";
import { MIN_HUMAN_TEST, MIN_HUMAN_TRAIN, buildTrainingExport, parseLanes, toJsonl } from "../training/export.ts";
import type { McpAccess } from "../mcp/access.ts";
import { cameThroughProxy } from "../mcp/access.ts";
import type { AppSettings } from "../settings/settings.ts";
import { SettingsError } from "../settings/settings.ts";

export interface AppDeps {
  store: Store;
  ingestor: Ingestor;
  /** Optional: where feed logins are kept. Without it, feeds that need a login cannot be added. */
  secrets?: SecretStore;
  /** Optional: drafts rule proposals from votes and reasons. */
  proposer?: Proposer;
  /** Optional: picks the borderline item the reading view asks about. */
  ask?: LearningAsk;
  /** Optional: when present, rule and vote changes re-run the decision stage at once. */
  processor?: Processor;
  /** Optional: when present, a summary can be requested for one item. */
  summarizer?: ItemSummarizer;
  /** Optional: reads videos into text. Without it, /api/video reports that reading is off. */
  videoReader?: VideoReader;
  /** Builds briefings from stored summaries; defaults to one over the store. */
  briefer?: Briefer;
  /** Runs pipes; defaults to one over the store with no model, so questions for the AI wait. */
  pipes?: PipeEngine;
  /** Sends briefings to email, Telegram and Discord. Without it the Connect screen has no channels. */
  notifier?: Notifier;
  /** The MCP door for AI assistants. Without it, /mcp answers 404. */
  mcp?: McpAccess;
  /** The Connect screen's model and video settings. Without it, those settings can only be changed through the environment. */
  settings?: AppSettings;
  /** Host names the server answers on besides this machine's own (JUHANDU_PUBLIC_HOST), for a reverse proxy with a public name. */
  publicHosts?: string[];
  fetchImpl?: FetchLike;
  webRoot: string;
  version: string;
}

const MAX_BODY = 64 * 1024;
/** A pasted blocklist can be a few thousand lines. */
const MAX_IMPORT_BODY = 4 * 1024 * 1024;

/** An MCP message can be an object or a batch, unlike the other bodies, which are objects only. */
async function readMcpBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}

/** A request that carries a body must say it is JSON, which a form on another site cannot do without a permission check the browser makes first. */
function requireJsonBody(req: IncomingMessage): void {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  const hasBody = req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0");
  if (hasBody && type !== "application/json") throw new HttpError(415, "The body must be sent as application/json");
}

async function readJson(req: IncomingMessage, maxBytes = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

/** A source as the API shows it: a private link shows its host only, and no login value is ever part of a source. */
function publicSource(source: Source | undefined): Source | undefined {
  return source && source.auth === "url" ? { ...source, url: displayUrl(source.url) } : source;
}

function readLogin(raw: unknown): Login {
  try {
    return parseLogin(raw);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "That login is not valid");
  }
}

const RULE_KINDS: RuleKind[] = ["block", "weight", "pin"];
const RULE_STATUSES: RuleStatus[] = ["active", "shadow", "disabled"];
const FIELDS = ["title", "text", "author"] as const;

function strings(value: unknown, limit = 50): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 300)).slice(0, limit) : [];
}

function fieldsOf(value: unknown): (typeof FIELDS)[number][] {
  const picked = Array.isArray(value) ? FIELDS.filter((f) => value.includes(f)) : [];
  return picked.length ? picked : ["title", "text"];
}

function parseCondition(raw: unknown): RuleCondition {
  if (!raw || typeof raw !== "object") throw new HttpError(400, "A condition is required");
  const c = raw as Record<string, unknown>;
  let condition: RuleCondition;
  if (c["type"] === "keyword") condition = { type: "keyword", terms: strings(c["terms"]), mode: c["mode"] === "all" ? "all" : "any", fields: fieldsOf(c["fields"]) };
  else if (c["type"] === "regex") condition = { type: "regex", pattern: typeof c["pattern"] === "string" ? c["pattern"] : "", flags: typeof c["flags"] === "string" ? c["flags"].replace(/[^imsu]/g, "") : "i", fields: fieldsOf(c["fields"]) };
  else if (c["type"] === "domain") condition = { type: "domain", domains: strings(c["domains"], MAX_LIST_ENTRIES).map((d) => d.trim().toLowerCase()).filter(Boolean) };
  else if (c["type"] === "semantic")
    condition = {
      type: "semantic",
      sentence: typeof c["sentence"] === "string" ? c["sentence"].slice(0, 500) : "",
      examples: strings(c["examples"], 20),
      counterExamples: strings(c["counterExamples"], 20),
      threshold: typeof c["threshold"] === "number" ? c["threshold"] : 0.6,
    };
  else throw new HttpError(400, "Condition type must be keyword, regex, domain or semantic");
  const problem = validateCondition(condition);
  if (problem) throw new HttpError(422, problem);
  return condition;
}

function parseScope(raw: unknown): RuleScope {
  if (!raw || typeof raw !== "object") return { type: "all" };
  const s = raw as Record<string, unknown>;
  if (s["type"] === "folder" && typeof s["folder"] === "string") return { type: "folder", folder: s["folder"] };
  if (s["type"] === "source" && Number.isInteger(s["sourceId"])) return { type: "source", sourceId: s["sourceId"] as number };
  return { type: "all" };
}

function parseRule(body: Record<string, unknown>, partial: boolean): Partial<NewRule> {
  const rule: Partial<NewRule> = {};
  if (!partial || body["kind"] !== undefined) {
    if (!RULE_KINDS.includes(body["kind"] as RuleKind)) throw new HttpError(400, "Rule kind must be block, weight or pin");
    rule.kind = body["kind"] as RuleKind;
  }
  if (!partial || body["condition"] !== undefined) rule.condition = parseCondition(body["condition"]);
  if (!partial || body["scope"] !== undefined) rule.scope = parseScope(body["scope"]);
  if (body["weight"] !== undefined) {
    if (typeof body["weight"] !== "number" || body["weight"] < -1 || body["weight"] > 1) throw new HttpError(400, "Weight must be a number from -1 to 1");
    rule.weight = body["weight"];
  }
  if (body["status"] !== undefined) {
    if (!RULE_STATUSES.includes(body["status"] as RuleStatus)) throw new HttpError(400, "Status must be active, shadow or disabled");
    rule.status = body["status"] as RuleStatus;
  }
  if (typeof body["note"] === "string") rule.note = body["note"].slice(0, 300);
  return rule;
}

/** A proposal as the web shows it: the draft plus the titles and reasons of the votes it came from. */
function proposalView(store: Store, proposal: Proposal) {
  const evidence = proposal.evidence.slice(0, 12).flatMap((id) => {
    const item = store.listItems({ itemId: id, view: "all", limit: 1 })[0];
    return item ? [{ id: item.id, title: item.title, sourceTitle: item.sourceTitle, vote: item.vote, reason: item.voteReason }] : [];
  });
  return { ...proposal, evidence: undefined, evidenceCount: proposal.evidence.length, evidenceItems: evidence };
}

function intParam(value: string | null, fallback?: number): number | undefined {
  if (value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "Query values must be non-negative integers");
  return n;
}

async function serveStatic(res: ServerResponse, webRoot: string, pathname: string): Promise<boolean> {
  const root = resolve(webRoot);
  const relative = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  const full = resolve(join(root, relative));
  if (full !== root && !full.startsWith(root + sep)) return false;
  try {
    const data = await readFile(full);
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": TYPES[extname(full)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export function createApp(deps: AppDeps): Server {
  const { store, ingestor } = deps;
  const briefer = deps.briefer ?? new Briefer(store);
  const pipes = deps.pipes ?? new PipeEngine({ store });
  const pipeJson = (p: StoredPipe) => ({ id: p.id, slug: p.slug, name: p.name, doc: p.doc, tier: pipes.tierOf(p.doc), usedBy: pipes.usedBy(p.id), feedPath: p.doc.output.publish ? `/pipes/${p.slug}.xml` : null, updatedAt: p.updatedAt });
  const readPipeBody = (body: Record<string, unknown>, partial: boolean) => {
    const name = typeof body["name"] === "string" ? body["name"].trim().slice(0, 80) : undefined;
    if ((!partial && !name) || name === "") throw new HttpError(400, "A pipe needs a name");
    let doc;
    if (!partial || body["doc"] !== undefined) {
      try {
        doc = parsePipeDoc(body["doc"]);
      } catch (error) {
        throw new HttpError(422, error instanceof Error ? error.message : "That pipe is not valid");
      }
      if (doc.output.publish && pipes.tierOf(doc) === "private") throw new HttpError(422, "A pipe that reads a private feed cannot be published as a feed");
    }
    return { name, doc };
  };
  const pipeRun = (doc: ReturnType<typeof parsePipeDoc>, id: number | null) => {
    if (pipes.wouldLoop(id, doc)) throw new HttpError(422, "That would make the pipe read itself through another pipe");
    try {
      return pipes.evaluate(doc, { stack: id === null ? [] : [id] });
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : "That pipe cannot run");
    }
  };
  /** The video reader's ways of reading. Gemini counts as not ready while the last Test of the key in use failed. */
  const videoRungs = async (): Promise<RungStatus[]> => {
    const rungs = deps.videoReader ? await deps.videoReader.status() : [];
    const failure = deps.settings ? await deps.settings.geminiTestFailure() : null;
    if (!failure) return rungs;
    return rungs.map((r) => (r.id === "gemini" && r.ready ? { ...r, ready: false, failed: true, reason: failure } : r));
  };
  const mcpServer = deps.mcp ? new McpServer({ store, briefer, pipes, settings: () => (deps.mcp as McpAccess).settings(), version: deps.version }) : undefined;
  const channelOf = (raw: string | undefined): ChannelId => {
    const id = CHANNELS.find((c) => c === raw);
    if (!id) throw new HttpError(404, "No such channel");
    return id;
  };
  const notifying = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof NotifyError) throw new HttpError(422, error.message);
      throw error;
    }
  };
  const credentials = deps.secrets ? new Credentials(deps.secrets) : undefined;
  const scrub = (text: string): string => (credentials ? credentials.redact(text) : text);

  const guard = new RequestGuard(deps.publicHosts);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;

    const feedMatch = path.match(/^\/pipes\/([a-z0-9-]{1,60})\.xml$/);
    if (feedMatch && (method === "GET" || method === "HEAD")) {
      const pipe = store.getPipeBySlug(feedMatch[1] as string);
      if (!pipe || !pipe.doc.output.publish) throw new HttpError(404, "No such feed");
      if (pipes.tierOf(pipe.doc) === "private") throw new HttpError(403, "This pipe reads a private feed, so it is not served");
      const result = pipeRun(pipe.doc, pipe.id);
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/atom+xml; charset=utf-8", "cache-control": "no-store" });
      res.end(method === "HEAD" ? undefined : renderAtom(pipe, result.entries, new Date()));
      return;
    }

    if (path === "/mcp") {
      if (!deps.mcp || !mcpServer) throw new HttpError(404, "Not found");
      if (!(await deps.mcp.allows({ authorization: req.headers.authorization, host: req.headers.host, origin: req.headers.origin, proxied: cameThroughProxy(req.headers) }))) throw new HttpError(403, "Not allowed");
      if (method !== "POST") {
        res.writeHead(405, { ...SECURITY_HEADERS, allow: "POST", "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Use POST" }));
        return;
      }
      const body = await readMcpBody(req);
      const answer = await mcpServer.handle(body);
      if (answer === null) {
        res.writeHead(202, { ...SECURITY_HEADERS, "cache-control": "no-store" });
        res.end();
        return;
      }
      return send(res, 200, answer);
    }

    if (path.startsWith("/api/")) {
      const refused = guard.refusal({ host: req.headers.host, origin: req.headers.origin });
      if (refused) throw new HttpError(403, refused);
      requireJsonBody(req);
      if (method === "GET" && path === "/api/notify") {
        if (!deps.notifier) return send(res, 200, { channels: [], recent: [] });
        return send(res, 200, { channels: await deps.notifier.status(), recent: store.listDeliveries(10) });
      }
      const notifyMatch = path.match(/^\/api\/notify\/([a-z]+)(\/test)?$/);
      if (notifyMatch && notifyMatch[1] !== "send") {
        if (!deps.notifier) throw new HttpError(503, "Notifications are not set up");
        const notifier = deps.notifier;
        const id = channelOf(notifyMatch[1]);
        if (method === "PUT" && !notifyMatch[2]) {
          const body = await readJson(req);
          const secret = body["secret"] === null ? null : typeof body["secret"] === "string" ? body["secret"].trim() : undefined;
          const { secret: _ignored, ...patch } = body;
          return send(res, 200, { channel: await notifying(() => notifier.update(id, patch, secret)) });
        }
        if (method === "POST" && notifyMatch[2]) {
          await notifying(() => notifier.test(id));
          return send(res, 200, { ok: true });
        }
      }
      if (method === "POST" && path === "/api/notify/send") {
        if (!deps.notifier) throw new HttpError(503, "Notifications are not set up");
        const notifier = deps.notifier;
        const body = await readJson(req);
        const briefingId = typeof body["briefingId"] === "number" ? body["briefingId"] : store.listBriefings(1)[0]?.id;
        if (briefingId === undefined) throw new HttpError(404, "There is no briefing to send yet");
        const only = Array.isArray(body["channels"]) ? body["channels"].map((c) => channelOf(typeof c === "string" ? c : undefined)) : undefined;
        const results = await notifying(() => notifier.deliverBriefing(briefingId, { force: true, ...(only ? { only } : {}) }));
        return send(res, 200, { briefingId, results });
      }
      if (path === "/api/mcp" && method === "GET") {
        if (!deps.mcp) return send(res, 200, { available: false });
        return send(res, 200, { available: true, ...(await deps.mcp.status()), proxied: cameThroughProxy(req.headers) });
      }
      if (path === "/api/mcp" && method === "PUT") {
        if (!deps.mcp) throw new HttpError(503, "The assistant door is not set up");
        const body = await readJson(req);
        deps.mcp.update({
          ...(typeof body["allowWrites"] === "boolean" ? { allowWrites: body["allowWrites"] } : {}),
          ...(typeof body["includePrivate"] === "boolean" ? { includePrivate: body["includePrivate"] } : {}),
        });
        let token: string | undefined;
        if (body["token"] === "new") {
          try {
            token = await deps.mcp.newToken();
          } catch (error) {
            throw new HttpError(503, error instanceof Error ? error.message : "A token could not be made");
          }
        } else if (body["token"] === null) await deps.mcp.clearToken();
        return send(res, 200, { available: true, ...(await deps.mcp.status()), proxied: cameThroughProxy(req.headers), ...(token ? { token } : {}) });
      }
      if (path === "/api/settings" && method === "GET") {
        if (!deps.settings) throw new HttpError(503, "Settings are not available");
        return send(res, 200, await deps.settings.status());
      }
      const settingsMatch = path.match(/^\/api\/settings\/(?:endpoints\/([a-z]+)|(host)|(video))(\/test|\/gemini\/test)?$/);
      if (settingsMatch && (method === "PUT" || method === "POST")) {
        if (!deps.settings) throw new HttpError(503, "Settings are not available");
        const settings = deps.settings;
        const [, endpointId, host, video, test] = settingsMatch;
        if (method === "PUT" && !test) {
          const body = await readJson(req);
          if (endpointId) await settings.saveEndpoint(endpointId, body);
          else if (host) await settings.saveHost(body);
          else await settings.saveVideo(body);
          return send(res, 200, await settings.status());
        }
        if (method === "POST" && endpointId && test === "/test") return send(res, 200, await settings.testEndpoint(endpointId));
        if (method === "POST" && host && test === "/test") return send(res, 200, await settings.testCogitator());
        if (method === "POST" && video && test === "/gemini/test") return send(res, 200, await settings.testGemini());
      }
      if (path === "/api/setup" && method === "GET") {
        const rungs = await videoRungs();
        const channels = deps.notifier ? await deps.notifier.status() : [];
        return send(res, 200, {
          dismissed: store.getMeta("setup:dismissed") === "1",
          steps: {
            feed: store.listSources().length > 0,
            model: Boolean(deps.summarizer),
            video: rungs.some((r) => r.ready),
            delivery: channels.some((c) => c.ready),
          },
        });
      }
      if (path === "/api/setup" && method === "PUT") {
        const body = await readJson(req);
        if (typeof body["dismissed"] !== "boolean") throw new HttpError(400, "dismissed must be true or false");
        store.setMeta("setup:dismissed", body["dismissed"] ? "1" : "0");
        return send(res, 200, { dismissed: body["dismissed"] });
      }
      if (method === "GET" && path === "/api/video") {
        const summary = store.videoSummary();
        return send(res, 200, { enabled: Boolean(deps.videoReader), rungs: await videoRungs(), ...summary });
      }
      if (method === "GET" && path === "/api/training") {
        const built = buildTrainingExport(store, { includePrivate: url.searchParams.get("private") === "1" });
        return send(res, 200, { lanes: built.summaries, minHumanTrain: MIN_HUMAN_TRAIN, minHumanTest: MIN_HUMAN_TEST, logged: store.laneCounts() });
      }
      if (method === "GET" && path === "/api/training/export") {
        let lanes;
        try {
          lanes = parseLanes(url.searchParams.get("lane"));
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : "Unknown lane");
        }
        const built = buildTrainingExport(store, { lanes, includePrivate: url.searchParams.get("private") === "1" });
        res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "application/x-ndjson; charset=utf-8", "content-disposition": 'attachment; filename="juhandu-training.jsonl"', "cache-control": "no-store" });
        res.end(toJsonl(built.rows));
        return;
      }
      if (method === "GET" && path === "/api/health") return send(res, 200, { ok: true, version: deps.version, ...store.counts() });
      if (method === "GET" && path === "/api/sources") return send(res, 200, { sources: store.listSources().map((s) => publicSource(s)) });
      if (method === "GET" && path === "/api/secrets/status") return send(res, 200, { backends: deps.secrets ? await deps.secrets.status() : [] });
      if (method === "POST" && path === "/api/sources") {
        const body = await readJson(req);
        const login = body["login"] === undefined || body["login"] === null ? undefined : readLogin(body["login"]);
        if (login && !credentials) throw new HttpError(503, "Logins need the secret store, which is not set up");
        const raw = login?.kind === "url" ? login.url : typeof body["url"] === "string" ? body["url"] : "";
        if (!raw) throw new HttpError(400, "A url is required");
        const tier: DataTier = body["tier"] === "private" ? "private" : "public";
        const folder = typeof body["folder"] === "string" ? body["folder"].slice(0, 80) : "";
        let resolved;
        try {
          resolved = await resolveSource(raw, deps.fetchImpl, login ? loginHeaders(login) : {});
        } catch (error) {
          throw new HttpError(422, scrub(error instanceof Error ? error.message : "Could not read that address"));
        }
        const existing = login?.kind === "url" && credentials ? await credentials.findByLink(store.listSources(), resolved.feedUrl) : store.findSourceByUrl(resolved.feedUrl);
        if (existing) return send(res, 200, { source: publicSource(existing), alreadySubscribed: true });
        const source = store.addSource({ kind: resolved.kind, url: login?.kind === "url" ? maskUrl(resolved.feedUrl) : resolved.feedUrl, title: resolved.title, siteUrl: resolved.siteUrl, folder, tier, ...(login ? { auth: login.kind } : {}) });
        if (login && credentials) {
          try {
            await credentials.save(source.id, login.kind === "url" ? { kind: "url", url: resolved.feedUrl } : login);
          } catch (error) {
            store.removeSource(source.id);
            throw new HttpError(500, scrub(error instanceof Error ? error.message : "Could not store the login"));
          }
        }
        const inserted = store.upsertItems(
          source.id,
          resolved.feed.items.map((i) => toNewItem(i, resolved.feedUrl)),
        );
        return send(res, 201, { source: publicSource(store.getSource(source.id)), inserted });
      }
      const loginMatch = path.match(/^\/api\/sources\/(\d+)\/login$/);
      if (loginMatch && (method === "PUT" || method === "DELETE")) {
        const id = Number(loginMatch[1]);
        const source = store.getSource(id);
        if (!source) throw new HttpError(404, "No such source");
        if (!credentials) throw new HttpError(503, "Logins need the secret store, which is not set up");
        const sameFamily = "A private link cannot be turned into another kind of login, or the other way round. Remove the feed and add it again.";
        if (method === "DELETE") {
          if (source.auth === "url") throw new HttpError(422, sameFamily);
          await credentials.remove(id);
          store.setSourceAuth(id, null);
          return send(res, 200, { source: publicSource(store.getSource(id)) });
        }
        const body = await readJson(req);
        const login = readLogin(body["login"]);
        if ((login.kind === "url") !== (source.auth === "url")) throw new HttpError(422, sameFamily);
        try {
          await credentials.save(id, login);
        } catch (error) {
          throw new HttpError(500, scrub(error instanceof Error ? error.message : "Could not store the login"));
        }
        store.setSourceAuth(id, login.kind);
        store.retrySourceNow(id);
        return send(res, 200, { source: publicSource(store.getSource(id)) });
      }
      const sourceMatch = path.match(/^\/api\/sources\/(\d+)(\/poll)?$/);
      if (sourceMatch) {
        const id = Number(sourceMatch[1]);
        const source = store.getSource(id);
        if (!source) throw new HttpError(404, "No such source");
        if (method === "DELETE" && !sourceMatch[2]) {
          const removed = store.removeSource(id);
          if (credentials && source.auth) await credentials.remove(id);
          return send(res, 200, { removed });
        }
        if (method === "POST" && sourceMatch[2]) return send(res, 200, await ingestor.pollSource(source));
      }
      if (method === "GET" && path === "/api/rules") {
        const counts = store.ruleMatchCounts();
        const meters = ruleMeters(store);
        return send(res, 200, { rules: store.listRules().map((rule) => ({ ...rule, matched: counts.get(rule.id)?.acting ?? 0, shadowMatched: counts.get(rule.id)?.shadow ?? 0, meter: meters.get(rule.id) ?? null })) });
      }
      if (method === "GET" && path === "/api/proposals") {
        const proposals = store.listProposals("pending").map((p) => proposalView(store, p));
        return send(res, 200, { proposals });
      }
      if (method === "POST" && path === "/api/proposals/run") {
        if (!deps.proposer) throw new HttpError(503, "Suggestions need a chat model and an embedding model");
        const run = await deps.proposer.run("interactive");
        return send(res, 200, { run, proposals: store.listProposals("pending").map((p) => proposalView(store, p)) });
      }
      const proposalMatch = path.match(/^\/api\/proposals\/(\d+)\/(accept|reject)$/);
      if (method === "POST" && proposalMatch) {
        const proposal = store.getProposal(Number(proposalMatch[1]));
        if (!proposal || proposal.status !== "pending") throw new HttpError(404, "No such pending suggestion");
        if (proposalMatch[2] === "reject") {
          store.decideProposal(proposal.id, "rejected", null);
          return send(res, 200, { ok: true });
        }
        const body = await readJson(req);
        const edits = parseRule({ kind: proposal.kind, condition: proposal.condition, scope: proposal.scope, ...body, status: "shadow" }, false);
        const rule = store.addRule({
          kind: edits.kind ?? proposal.kind,
          scope: edits.scope ?? proposal.scope,
          condition: edits.condition ?? proposal.condition,
          weight: edits.weight ?? proposal.weight,
          status: "shadow",
          origin: "learned",
          note: edits.note ?? proposal.rationale.slice(0, 300),
        });
        store.decideProposal(proposal.id, "accepted", rule.id);
        await deps.processor?.decidePending("interactive");
        return send(res, 201, { rule });
      }
      const promoteMatch = path.match(/^\/api\/rules\/(\d+)\/promote$/);
      if (method === "POST" && promoteMatch) {
        const rule = store.getRule(Number(promoteMatch[1]));
        if (!rule) throw new HttpError(404, "No such rule");
        if (rule.status !== "shadow") throw new HttpError(409, "Only a rule in shadow can be made live");
        const promoted = store.promoteRule(rule.id);
        await deps.processor?.decidePending("interactive");
        return send(res, 200, { rule: promoted });
      }
      if (method === "GET" && path === "/api/learning/ask") {
        const id = deps.ask ? await deps.ask.next() : null;
        const item = id ? store.listItems({ itemId: id, view: "all", limit: 1 })[0] : undefined;
        return send(res, 200, { item: item ?? null, settings: deps.ask?.settings() ?? null });
      }
      if (method === "POST" && path === "/api/learning/ask/skip") {
        const body = await readJson(req);
        if (!deps.ask || !Number.isInteger(body["itemId"])) throw new HttpError(400, "An itemId is required");
        deps.ask.skip(body["itemId"] as number);
        return send(res, 200, { ok: true });
      }
      if (path === "/api/settings/learning") {
        if (!deps.ask) throw new HttpError(503, "Learning settings are not available");
        if (method === "PUT") {
          const body = await readJson(req);
          return send(res, 200, deps.ask.setSettings({ ...(typeof body["enabled"] === "boolean" ? { enabled: body["enabled"] } : {}), ...(typeof body["perDay"] === "number" ? { perDay: body["perDay"] } : {}) }));
        }
        if (method === "GET") return send(res, 200, deps.ask.settings());
      }
      if (method === "POST" && (path === "/api/rules/import/preview" || path === "/api/rules/import")) {
        const body = await readJson(req, MAX_IMPORT_BODY);
        const format: ListFormat = body["format"] === "domains" ? "domains" : "words";
        const text = typeof body["text"] === "string" ? body["text"] : "";
        if (!text.trim()) throw new HttpError(400, "The list is empty");
        const parsed = parseList(format, text);
        if (!parsed.entries.length) throw new HttpError(422, "No usable lines were found in that list");
        const fields = fieldsOf(body["fields"]);
        const name = typeof body["name"] === "string" && body["name"].trim() ? body["name"].trim().slice(0, 80) : format === "domains" ? "Imported domain list" : "Imported word list";
        const options = { format, group: body["group"] === "each" ? ("each" as const) : ("list" as const), name, scope: parseScope(body["scope"]), fields };
        const existing = store.listRules();
        if (path.endsWith("/preview")) {
          const preview = previewList(format, parsed.entries, store.recentItemsForPreview(200), fields);
          const shown = preview.entries.filter((e) => e.matched > 0);
          return send(res, 200, {
            entryCount: parsed.entries.length,
            total: preview.total,
            wouldHide: preview.wouldHide,
            matching: shown.slice(0, 300),
            matchingCount: shown.length,
            unmatchedCount: preview.entries.length - shown.length,
            alreadyCovered: planImport(parsed.entries, options, existing).alreadyCovered.slice(0, 300),
            skipped: parsed.skipped.slice(0, 100),
            skippedCount: parsed.skipped.length,
          });
        }
        const excluded = new Set(strings(body["exclude"], MAX_LIST_ENTRIES).map((e) => e.toLowerCase()));
        const entries = parsed.entries.filter((e) => !excluded.has(e.toLowerCase()));
        if (!entries.length) throw new HttpError(422, "Every line was unticked, so there is nothing to import");
        const plan = planImport(entries, options, existing);
        for (const rule of plan.rules) {
          const problem = validateCondition(rule.condition);
          if (problem) throw new HttpError(422, problem);
        }
        const created = plan.rules.map((rule) => store.addRule(rule));
        await deps.processor?.decidePending("interactive");
        return send(res, 201, { created: created.length, ruleIds: created.map((r) => r.id), imported: entries.length - plan.alreadyCovered.length, alreadyCovered: plan.alreadyCovered.length, grouped: created.length > 1 ? "each" : "list" });
      }
      if (method === "POST" && path === "/api/rules") {
        const rule = store.addRule(parseRule(await readJson(req), false) as NewRule);
        await deps.processor?.decidePending("interactive");
        return send(res, 201, { rule });
      }
      if (method === "POST" && path === "/api/rules/preview") {
        if (!deps.processor) throw new HttpError(503, "Previews need the processor");
        const body = await readJson(req);
        const rows = await deps.processor.preview(parseCondition(body["condition"]));
        return send(res, 200, { rows: rows.slice(0, 100), matched: rows.filter((r) => r.matched).length, total: rows.length });
      }
      const ruleMatch = path.match(/^\/api\/rules\/(\d+)$/);
      if (ruleMatch) {
        const id = Number(ruleMatch[1]);
        if (method === "PATCH") {
          const rule = store.updateRule(id, parseRule(await readJson(req), true));
          if (!rule) throw new HttpError(404, "No such rule");
          await deps.processor?.decidePending("interactive");
          return send(res, 200, { rule });
        }
        if (method === "DELETE") {
          if (!store.removeRule(id)) throw new HttpError(404, "No such rule");
          await deps.processor?.decidePending("interactive");
          return send(res, 200, { removed: true });
        }
      }
      if (method === "GET" && path === "/api/items") {
        const viewParam = url.searchParams.get("view");
        const view: ItemView = viewParam === "filtered" || viewParam === "inbox" ? viewParam : "all";
        const items = store.listItems({
          view,
          limit: intParam(url.searchParams.get("limit"), 50),
          beforeId: intParam(url.searchParams.get("before")),
          sourceId: intParam(url.searchParams.get("source")),
          unreadOnly: url.searchParams.get("unread") === "1",
        });
        return send(res, 200, { items });
      }
      const actionMatch = path.match(/^\/api\/items\/(\d+)\/(vote|restore)$/);
      if (method === "POST" && actionMatch) {
        const id = Number(actionMatch[1]);
        if (actionMatch[2] === "vote") {
          const body = await readJson(req);
          const vote = body["vote"];
          if (vote !== 1 && vote !== -1 && vote !== 0) throw new HttpError(400, "Vote must be 1, -1 or 0");
          if (!store.setVote(id, vote, typeof body["reason"] === "string" ? body["reason"] : "")) throw new HttpError(404, "No such item");
          return send(res, 200, { ok: true });
        }
        if (!store.restoreItem(id)) throw new HttpError(404, "No such item, or it was never filtered");
        return send(res, 200, { ok: true });
      }
      if (path === "/api/briefings" && method === "GET") return send(res, 200, { briefings: store.listBriefings(30) });
      if (path === "/api/briefings" && method === "POST") {
        const body = await readJson(req);
        const kind: BriefingKind = body["kind"] === "catchup" ? "catchup" : body["kind"] === "daily" ? "daily" : "ondemand";
        const hours = typeof body["hours"] === "number" && body["hours"] > 0 && body["hours"] <= 24 * 30 ? body["hours"] : undefined;
        return send(res, 201, { briefing: briefer.build({ kind, ...(hours ? { hours } : {}) }) });
      }
      const briefingMatch = path.match(/^\/api\/briefings\/(\d+)(\/read)?$/);
      if (briefingMatch) {
        const briefing = briefer.get(Number(briefingMatch[1]));
        if (!briefing) throw new HttpError(404, "No such briefing");
        if (method === "GET" && !briefingMatch[2]) return url.searchParams.get("format") === "md" ? sendText(res, 200, renderMarkdown(briefing)) : send(res, 200, { briefing });
        if (method === "POST" && briefingMatch[2]) {
          const ids = briefing.sections.flatMap((s) => s.entries.flatMap((e) => e.links.map((l) => l.id)));
          return send(res, 200, { marked: store.markItemsRead(ids) });
        }
      }
      const summaryMatch = path.match(/^\/api\/items\/(\d+)\/summary$/);
      if (method === "POST" && summaryMatch) {
        if (!deps.summarizer) throw new HttpError(503, "Summaries need a chat model");
        const result = await deps.summarizer.summarizeNow(Number(summaryMatch[1]));
        if (result === "unknown") throw new HttpError(404, "No such item");
        if (result === "too-short") throw new HttpError(422, "This item has too little text to summarize");
        if (result === "failed") throw new HttpError(502, "The model did not return a usable summary");
        return send(res, 200, { summary: result });
      }
      if (method === "POST" && (path === "/api/import/opml/preview" || path === "/api/import/opml")) {
        const body = await readJson(req, MAX_IMPORT_BODY);
        const text = typeof body["opml"] === "string" ? body["opml"] : "";
        if (!text.trim()) throw new HttpError(400, "The OPML text is empty");
        try {
          if (path.endsWith("/preview")) return send(res, 200, previewOpml(store, text));
          const skip = Array.isArray(body["skip"]) ? body["skip"].filter((s): s is string => typeof s === "string") : [];
          return send(res, 201, importOpml(store, text, { tier: body["tier"] === "private" ? "private" : "public", skip }));
        } catch (error) {
          throw new HttpError(422, error instanceof Error ? error.message : "Could not read that file");
        }
      }
      if (path === "/api/pipes" && method === "GET") return send(res, 200, { pipes: store.listPipes().map(pipeJson) });
      if (path === "/api/pipes" && method === "POST") {
        const body = await readJson(req);
        const { name, doc } = readPipeBody(body, false);
        let slug = slugify(name as string);
        for (let n = 2; store.getPipeBySlug(slug); n++) slug = `${slugify(name as string)}-${n}`;
        return send(res, 201, { pipe: pipeJson(store.addPipe({ slug, name: name as string, doc: doc as NonNullable<typeof doc> })) });
      }
      if (path === "/api/pipes/preview" && method === "POST") {
        const body = await readJson(req);
        const { doc } = readPipeBody({ name: "preview", doc: body["doc"] }, false);
        const id = typeof body["id"] === "number" ? body["id"] : null;
        return send(res, 200, pipeRun(doc as NonNullable<typeof doc>, id));
      }
      const pipeMatch = path.match(/^\/api\/pipes\/(\d+)(\/items)?$/);
      if (pipeMatch) {
        const pipe = store.getPipe(Number(pipeMatch[1]));
        if (!pipe) throw new HttpError(404, "No such pipe");
        if (pipeMatch[2] && method === "GET") return send(res, 200, pipeRun(pipe.doc, pipe.id));
        if (!pipeMatch[2] && method === "GET") return send(res, 200, { pipe: pipeJson(pipe) });
        if (!pipeMatch[2] && method === "PUT") {
          const { name, doc } = readPipeBody(await readJson(req), true);
          if (doc && pipes.wouldLoop(pipe.id, doc)) throw new HttpError(422, "That would make the pipe read itself through another pipe");
          return send(res, 200, { pipe: pipeJson(store.updatePipe(pipe.id, { ...(name !== undefined ? { name } : {}), ...(doc ? { doc } : {}) }) as StoredPipe) });
        }
        if (!pipeMatch[2] && method === "DELETE") {
          const users = pipes.usedBy(pipe.id).map((id) => store.getPipe(id)?.name ?? String(id));
          if (users.length) throw new HttpError(409, `Other pipes read this one: ${users.join(", ")}. Change them first.`);
          store.removePipe(pipe.id);
          return send(res, 200, { ok: true });
        }
      }
      if (method === "POST" && path === "/api/items/read-all") return send(res, 200, { marked: store.markAllRead() });
      const itemMatch = path.match(/^\/api\/items\/(\d+)\/read$/);
      if (method === "POST" && itemMatch) {
        const body = await readJson(req);
        const ok = store.setRead(Number(itemMatch[1]), body["read"] !== false);
        if (!ok) throw new HttpError(404, "No such item");
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, "Not found");
    }

    if ((method === "GET" || method === "HEAD") && (await serveStatic(res, deps.webRoot, path))) return;
    throw new HttpError(404, "Not found");
  }

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      if (error instanceof SettingsError) return send(res, error.status, { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.place ? { place: error.place } : {}) });
      if (error instanceof NoEndpointError) return send(res, 503, { error: "No model is available right now" });
      console.error("Unhandled request error:", error);
      send(res, 500, { error: "Internal error" });
    });
  });
}
