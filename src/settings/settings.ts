// The settings the Connect screen changes: which model host is used, the four OpenAI-style endpoints, Cogitator, and video reading.
// Every setting has an environment variable, and a variable that is set always wins over the saved value, so a server set up through its
// environment keeps working and the screen shows those values as set by the server. Addresses, model names and switches are kept in the
// database's meta table; keys go to the secret store, and only whether a key is set ever leaves this file.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { buildProvider, chooseAdapter, cogitatorPresent, endpointFrom, isLoopback } from "../models/setup.ts";
import type { OpenAIEndpoint } from "../models/openai.ts";
import { envWithSecrets } from "../secrets/env.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { FetchLike } from "../sources/fetcher.ts";
import type { Store } from "../store/store.ts";
import { ProgramFinder } from "../video/exec.ts";
import { placeOf, systemResolver, UnknownHostError } from "./address.ts";
import type { AddressPlace, Resolver } from "./address.ts";
import { probeChat, probeEmbed, probeGemini, probeTranscribe, probeVision } from "./probe.ts";
import type { ProbeResult } from "./probe.ts";

type Env = Record<string, string | undefined>;

export type EndpointId = "chat" | "embed" | "transcribe" | "vision";
export type HostChoice = "auto" | "openai" | "cogitator" | "off";
/** server: an environment variable or a read-only secret backend sets it. saved: set on the Connect screen. default: neither. */
export type Origin = "server" | "saved" | "default";

interface EndpointSpec {
  id: EndpointId;
  prefix: string;
  /** The endpoint's name for the egress gate and JUHANDU_PRIVATE_ALLOW. */
  name: string;
  /** The name the endpoint's key is kept under in the secret store. */
  stored: string;
  defaultModel: string;
}

export const ENDPOINTS: readonly EndpointSpec[] = [
  { id: "chat", prefix: "JUHANDU_CHAT", name: "chat", stored: "chat/key", defaultModel: "default" },
  { id: "embed", prefix: "JUHANDU_EMBED", name: "embeddings", stored: "embed/key", defaultModel: "nomic-embed-text-v1.5" },
  { id: "transcribe", prefix: "JUHANDU_TRANSCRIBE", name: "transcription", stored: "transcribe/key", defaultModel: "whisper-1" },
  { id: "vision", prefix: "JUHANDU_VISION", name: "vision", stored: "vision/key", defaultModel: "default" },
];

const HOSTS: HostChoice[] = ["auto", "openai", "cogitator", "off"];
const META = "settings:connect";
const GEMINI_SECRETS = ["gemini_api_key", "gemini/key"];
const GEMINI_TEST_META = "settings:gemini-test";

/** A short fingerprint of a key: enough to tell that the key changed, and too short to stand in for it or lead back to it. */
function fingerprint(key: string): string {
  return createHash("sha256").update(`juhandu-key-fingerprint:${key}`).digest("hex").slice(0, 16);
}

interface SavedEndpoint {
  url?: string;
  model?: string;
  local?: boolean;
}

interface Saved {
  endpoints?: Partial<Record<EndpointId, SavedEndpoint>>;
  host?: HostChoice;
  cogitatorUrl?: string;
  video?: boolean;
  gemini?: boolean;
}

export interface FieldView<T = string> {
  value: T;
  from: Origin;
  variable: string;
}

export interface KeyView {
  set: boolean;
  from: Origin;
  variable: string;
  /** The secret store name the screen writes the key to. */
  secret: string;
}

export interface EndpointView {
  id: EndpointId;
  url: FieldView;
  model: FieldView;
  /** Whether items from private feeds may go to it. */
  local: FieldView<boolean>;
  key: KeyView;
}

export interface SettingsView {
  host: FieldView<HostChoice> & { active: "openai" | "cogitator" | "off"; cogitatorFound: boolean };
  cogitator: { url: FieldView; interactiveKey: KeyView; backgroundKey: KeyView };
  endpoints: EndpointView[];
  video: { enabled: FieldView<boolean>; gemini: FieldView<boolean>; geminiKey: KeyView; tools: { ytdlp: boolean; ffmpeg: boolean; container: boolean } };
}

/** A request the settings cannot take. `code` tells the screen when it should ask for a confirmation and send the request again. */
export class SettingsError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly place: AddressPlace | undefined;
  constructor(status: number, message: string, extra: { code?: string; place?: AddressPlace } = {}) {
    super(message);
    this.name = "SettingsError";
    this.status = status;
    this.code = extra.code;
    this.place = extra.place;
  }
}

export interface SettingsOptions {
  store: Store;
  secrets: SecretStore;
  /** The process environment. It is only read. */
  env: Env;
  dataDir: string;
  /** Called after every change, so the server can rebuild its model and video setup without a restart. */
  onChange?: () => Promise<void>;
  fetchImpl?: FetchLike;
  resolve?: Resolver;
  finder?: ProgramFinder;
  /** True inside a container; read from /.dockerenv when left out. */
  container?: boolean;
}

function readUrl(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "string") throw new SettingsError(400, "The address must be text");
  const text = raw.trim();
  if (!text) return "";
  if (text.length > 500) throw new SettingsError(422, "That address is too long.");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SettingsError(422, "That is not a web address. It should start with http:// or https://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SettingsError(422, "That is not a web address. It should start with http:// or https://.");
  if (url.username || url.password) throw new SettingsError(422, "Leave the key out of the address and paste it into the key field.");
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

function readModel(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw !== "string") throw new SettingsError(400, "The model name must be text");
  const text = raw.trim();
  if (text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) throw new SettingsError(422, "That model name is not valid. Copy it from the server's list of models.");
  return text;
}

function readKey(raw: unknown): string {
  if (typeof raw !== "string") throw new SettingsError(400, "The key must be text");
  const text = raw.trim();
  if (!text) throw new SettingsError(422, "Paste a key before saving.");
  if (text.length > 4096 || /\s|[\u0000-\u001f\u007f]/.test(text)) throw new SettingsError(422, "A key is one line with no spaces. Copy it again and paste only the key.");
  return text;
}

export class AppSettings {
  private readonly store: Store;
  private readonly secrets: SecretStore;
  private readonly env: Env;
  private readonly dataDir: string;
  private readonly onChange: () => Promise<void>;
  private readonly fetchImpl: FetchLike;
  private readonly resolve: Resolver;
  private readonly finder: ProgramFinder;
  private readonly container: boolean;

  constructor(options: SettingsOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.env = options.env;
    this.dataDir = options.dataDir;
    this.onChange = options.onChange ?? (async () => {});
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolve = options.resolve ?? systemResolver;
    this.finder = options.finder ?? new ProgramFinder();
    this.container = options.container ?? existsSync("/.dockerenv");
  }

  private saved(): Saved {
    try {
      const parsed = JSON.parse(this.store.getMeta(META) ?? "{}") as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Saved) : {};
    } catch {
      return {};
    }
  }

  private write(saved: Saved): void {
    this.store.setMeta(META, JSON.stringify(saved));
  }

  private fromEnv(variable: string): boolean {
    return Boolean(this.env[variable]);
  }

  /** The environment the server builds its models and video reader from: the process environment, with saved values filled in where no variable is set, and stored keys added. */
  async effectiveEnv(): Promise<Env> {
    const out: Env = { ...this.env };
    const saved = this.saved();
    const fill = (variable: string, value: string | undefined) => {
      if (value && !this.env[variable]) out[variable] = value;
    };
    for (const spec of ENDPOINTS) {
      const s = saved.endpoints?.[spec.id];
      if (!s) continue;
      fill(`${spec.prefix}_URL`, s.url);
      fill(`${spec.prefix}_MODEL`, s.model);
      if (typeof s.local === "boolean") fill(`${spec.prefix}_LOCAL`, s.local ? "1" : "0");
    }
    // Vectors from different models must never be compared, so a model chosen here also names the vectors it makes.
    const embedModel = saved.endpoints?.embed?.model;
    if (embedModel && !this.env["JUHANDU_EMBED_MODEL"]) fill("JUHANDU_EMBED_TAG", embedModel);
    fill("JUHANDU_LOCAL_AI", saved.host);
    fill("JUHANDU_COGITATOR_URL", saved.cogitatorUrl);
    if (saved.video === false) fill("JUHANDU_VIDEO", "off");
    if (saved.gemini === false) fill("JUHANDU_GEMINI", "off");
    return envWithSecrets(out, this.secrets);
  }

  private async keyView(variables: string[], names: string[]): Promise<KeyView> {
    const view = { variable: variables[0] ?? "", secret: names[0] ?? "" };
    if (variables.some((v) => this.fromEnv(v))) return { set: true, from: "server", ...view };
    for (const name of names) {
      const origin = await this.secrets.origin(name);
      if (origin) return { set: true, from: origin.writable ? "saved" : "server", ...view };
    }
    return { set: false, from: "default", ...view };
  }

  private field(variable: string, saved: string | undefined, fallback: string): FieldView {
    const env = this.env[variable];
    if (env) return { value: env, from: "server", variable };
    if (saved) return { value: saved, from: "saved", variable };
    return { value: fallback, from: "default", variable };
  }

  private switchField(variable: string, offWord: string, saved: boolean | undefined): FieldView<boolean> {
    const env = this.env[variable];
    if (env) return { value: env !== offWord, from: "server", variable };
    if (typeof saved === "boolean") return { value: saved, from: "saved", variable };
    return { value: true, from: "default", variable };
  }

  async status(): Promise<SettingsView> {
    const saved = this.saved();
    const effective = await this.effectiveEnv();
    const endpoints: EndpointView[] = [];
    for (const spec of ENDPOINTS) {
      const s = saved.endpoints?.[spec.id] ?? {};
      const url = this.field(`${spec.prefix}_URL`, s.url, "");
      const localVar = `${spec.prefix}_LOCAL`;
      const local: FieldView<boolean> = this.env[localVar] ? { value: this.env[localVar] === "1", from: "server", variable: localVar } : typeof s.local === "boolean" ? { value: s.local, from: "saved", variable: localVar } : { value: url.value ? isLoopback(url.value) : false, from: "default", variable: localVar };
      endpoints.push({
        id: spec.id,
        url: { ...url, value: url.value ? safeUrl(url.value) : "" },
        model: this.field(`${spec.prefix}_MODEL`, s.model, spec.defaultModel),
        local,
        key: await this.keyView([`${spec.prefix}_KEY`], [spec.stored]),
      });
    }
    const hostEnv = this.env["JUHANDU_LOCAL_AI"];
    const hostValue = (HOSTS.find((h) => h === (hostEnv || saved.host)) ?? "auto") as HostChoice;
    const [ytdlp, ffmpeg] = await Promise.all([this.finder.find("yt-dlp", this.env["JUHANDU_YTDLP"]), this.finder.find("ffmpeg", this.env["JUHANDU_FFMPEG"], "-version")]);
    return {
      host: { value: hostValue, from: hostEnv ? "server" : saved.host ? "saved" : "default", variable: "JUHANDU_LOCAL_AI", active: chooseAdapter(effective), cogitatorFound: cogitatorPresent(effective) },
      cogitator: {
        url: (() => {
          const f = this.field("JUHANDU_COGITATOR_URL", saved.cogitatorUrl, "");
          return { ...f, value: f.value ? safeUrl(f.value) : "" };
        })(),
        interactiveKey: await this.keyView(["JUHANDU_COGITATOR_KEY_FILE"], ["cogitator/interactive"]),
        backgroundKey: await this.keyView(["JUHANDU_COGITATOR_BACKGROUND_KEY_FILE"], ["cogitator/background"]),
      },
      endpoints,
      video: {
        enabled: this.switchField("JUHANDU_VIDEO", "off", saved.video),
        gemini: this.switchField("JUHANDU_GEMINI", "off", saved.gemini),
        geminiKey: await this.keyView(["JUHANDU_GEMINI_KEY"], GEMINI_SECRETS),
        tools: { ytdlp: Boolean(ytdlp), ffmpeg: Boolean(ffmpeg), container: this.container },
      },
    };
  }

  /** Checks a new address, and refuses one on this machine or a private network unless the request confirms it. */
  private async checkAddress(url: string, confirmed: boolean): Promise<void> {
    let place: AddressPlace;
    try {
      place = await placeOf(url, this.resolve);
    } catch (error) {
      if (error instanceof UnknownHostError) throw new SettingsError(422, `Juhandu could not find the host name ${error.host}. Check the spelling.`);
      throw error;
    }
    if (place !== "internet" && !confirmed) {
      const where = place === "this-machine" ? "this computer" : "a private network";
      throw new SettingsError(409, `That address points to ${where}. Save it only if this server is yours.`, { code: "confirm-address", place });
    }
  }

  private async setKey(name: string, variables: string[], raw: unknown, alsoDelete: string[] = []): Promise<void> {
    if (raw === undefined) return;
    if (variables.some((v) => this.fromEnv(v))) throw new SettingsError(409, `The server's environment sets this key (${variables[0]}), so it cannot be changed here.`);
    for (const n of [name, ...alsoDelete]) {
      const origin = await this.secrets.origin(n);
      if (origin && !origin.writable) throw new SettingsError(409, `The server's ${origin.id} secret store sets this key, so it cannot be changed here.`);
    }
    if (raw === null) {
      for (const n of [name, ...alsoDelete]) await this.secrets.delete(n);
      return;
    }
    const value = readKey(raw);
    try {
      await this.secrets.set(name, value);
    } catch (error) {
      throw new SettingsError(503, `The key could not be stored: ${this.secrets.redact(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private refuseServer(variable: string): void {
    if (this.fromEnv(variable)) throw new SettingsError(409, `The server's environment sets this (${variable}), so it cannot be changed here.`);
  }

  /** Saves an endpoint's address, model, private-feed switch and key. A field left out of the body is kept; null clears it. */
  async saveEndpoint(id: string, body: Record<string, unknown>): Promise<void> {
    const spec = ENDPOINTS.find((e) => e.id === id);
    if (!spec) throw new SettingsError(404, "No such model setting");
    const saved = this.saved();
    const current: SavedEndpoint = { ...(saved.endpoints?.[spec.id] ?? {}) };
    if (body["url"] !== undefined) {
      this.refuseServer(`${spec.prefix}_URL`);
      const url = readUrl(body["url"]);
      if (url && url !== current.url) await this.checkAddress(url, body["confirmAddress"] === true);
      if (url) current.url = url;
      else delete current.url;
    }
    if (body["model"] !== undefined) {
      this.refuseServer(`${spec.prefix}_MODEL`);
      const model = readModel(body["model"]);
      if (model) current.model = model;
      else delete current.model;
    }
    if (body["local"] !== undefined) {
      this.refuseServer(`${spec.prefix}_LOCAL`);
      if (body["local"] === null) delete current.local;
      else if (typeof body["local"] === "boolean") current.local = body["local"];
      else throw new SettingsError(400, "local must be true, false or null");
    }
    await this.setKey(spec.stored, [`${spec.prefix}_KEY`], body["key"]);
    this.write({ ...saved, endpoints: { ...saved.endpoints, [spec.id]: current } });
    await this.onChange();
  }

  /** Saves the model host choice and Cogitator's address and keys. */
  async saveHost(body: Record<string, unknown>): Promise<void> {
    const saved = { ...this.saved() };
    if (body["host"] !== undefined) {
      this.refuseServer("JUHANDU_LOCAL_AI");
      const host = HOSTS.find((h) => h === body["host"]);
      if (!host) throw new SettingsError(400, "host must be auto, openai, cogitator or off");
      saved.host = host;
    }
    if (body["cogitatorUrl"] !== undefined) {
      this.refuseServer("JUHANDU_COGITATOR_URL");
      const url = readUrl(body["cogitatorUrl"]);
      if (url && url !== saved.cogitatorUrl) await this.checkAddress(url, body["confirmAddress"] === true);
      if (url) saved.cogitatorUrl = url;
      else delete saved.cogitatorUrl;
    }
    await this.setKey("cogitator/interactive", ["JUHANDU_COGITATOR_KEY_FILE"], body["interactiveKey"]);
    await this.setKey("cogitator/background", ["JUHANDU_COGITATOR_BACKGROUND_KEY_FILE"], body["backgroundKey"]);
    this.write(saved);
    await this.onChange();
  }

  /** Saves the video switches and the Gemini key. */
  async saveVideo(body: Record<string, unknown>): Promise<void> {
    const saved = { ...this.saved() };
    for (const [field, variable] of [["enabled", "JUHANDU_VIDEO"], ["gemini", "JUHANDU_GEMINI"]] as const) {
      if (body[field] === undefined) continue;
      this.refuseServer(variable);
      if (typeof body[field] !== "boolean") throw new SettingsError(400, `${field} must be true or false`);
      if (field === "enabled") saved.video = body[field] as boolean;
      else saved.gemini = body[field] as boolean;
    }
    await this.setKey("gemini_api_key", ["JUHANDU_GEMINI_KEY"], body["geminiKey"], body["geminiKey"] === null ? ["gemini/key"] : []);
    this.write(saved);
    await this.onChange();
  }

  /** The endpoint as the running server sees it, with its key. Never leaves the server. */
  private async endpoint(spec: EndpointSpec): Promise<OpenAIEndpoint | null> {
    const env = await this.effectiveEnv();
    try {
      return endpointFrom(env, spec.prefix, spec.name, spec.defaultModel);
    } catch {
      throw new SettingsError(422, `${spec.prefix}_EXTRA_BODY is not valid JSON.`);
    }
  }

  async testEndpoint(id: string): Promise<ProbeResult> {
    const spec = ENDPOINTS.find((e) => e.id === id);
    if (!spec) throw new SettingsError(404, "No such model setting");
    const endpoint = await this.endpoint(spec);
    if (!endpoint) return { ok: false, message: "No address is saved yet. Add one and save first." };
    const probe = { chat: probeChat, embed: probeEmbed, transcribe: probeTranscribe, vision: probeVision }[spec.id];
    return redactResult(await probe(endpoint, this.fetchImpl), this.secrets);
  }

  private async geminiKey(): Promise<string | undefined> {
    return this.env["JUHANDU_GEMINI_KEY"] || (await this.secrets.get("gemini_api_key")) || (await this.secrets.get("gemini/key"));
  }

  /** Tests the Gemini key. A failure is remembered against a fingerprint of the key, so the screen keeps showing it until a Test passes or the key changes. */
  async testGemini(): Promise<ProbeResult> {
    const key = await this.geminiKey();
    if (!key) return { ok: false, message: "No Gemini key is saved yet. Paste one and save first." };
    const result = redactResult(await probeGemini(key, this.fetchImpl), this.secrets);
    this.store.setMeta(GEMINI_TEST_META, JSON.stringify(result.ok ? {} : { key: fingerprint(key), message: result.message }));
    return result;
  }

  /** What the last Gemini Test said when it failed, or null when it passed, never ran, or ran with a key that is no longer in use. */
  async geminiTestFailure(): Promise<string | null> {
    let last: { key?: unknown; message?: unknown };
    try {
      last = JSON.parse(this.store.getMeta(GEMINI_TEST_META) ?? "{}") as typeof last;
    } catch {
      return null;
    }
    if (typeof last.key !== "string" || typeof last.message !== "string") return null;
    const key = await this.geminiKey();
    return key && fingerprint(key) === last.key ? last.message : null;
  }

  async testCogitator(): Promise<ProbeResult> {
    const env = { ...(await this.effectiveEnv()), JUHANDU_LOCAL_AI: "cogitator" };
    if (!cogitatorPresent(env)) return { ok: false, message: "Cogitator was not found on this computer. Add its address and save first." };
    const provider = buildProvider(env, this.dataDir, this.secrets);
    if (!provider) return { ok: false, message: "Cogitator could not be set up." };
    const status = await provider.status();
    return redactResult(status.ok ? { ok: true, message: `Cogitator answered and serves ${status.serves.join(", ") || "no roles yet"}.` } : { ok: false, message: `Cogitator did not answer: ${status.detail}` }, this.secrets);
  }
}

/** An address as the screen shows it: no login, query or fragment, since an address from the environment could carry a token in any of them. */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function redactResult(result: ProbeResult, secrets: SecretStore): ProbeResult {
  return { ok: result.ok, message: secrets.redact(result.message) };
}
