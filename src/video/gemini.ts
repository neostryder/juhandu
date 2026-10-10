// The first rung: Gemini reads a public YouTube video straight from its address, on the free tier. Public tier only; a private item never goes to a hosted service.
import type { SecretStore } from "../secrets/store.ts";
import type { FetchLike } from "../sources/fetcher.ts";
import { clip } from "./transcript.ts";
import { watchUrl } from "./ids.ts";
import { RungFailed, RungSkipped } from "./types.ts";
import type { VideoReading, VideoRung, VideoTarget } from "./types.ts";

const API = "https://generativelanguage.googleapis.com/v1beta";
const FALLBACK_MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"];
const MODEL_LIST_TTL_MS = 6 * 3_600_000;
const KEY_COOLDOWN_MS = 3_600_000;
const MAX_TEXT_CHARS = 6_000;

const PROMPT = [
  "Watch this video and write plain text for a busy reader, no markdown.",
  "First a gist of two sentences: what the video is and what it concludes.",
  "Then 5 to 10 lines, each starting with the timestamp as MM:SS, a dash, and one specific point made or shown there.",
  "Mark anything that is shown on screen but never said with the words Visual-only: at the start of its line.",
  "Add one line starting with Doubtful: for any claim that looks wrong or unsupported, or leave it out when there is none.",
  "Quote exact words for any number, name or claim. Do not invent anything the video does not contain.",
].join(" ");

/** Newest first, so a new Gemini release is picked up without a code change; lite models go last because they read worse. */
export function orderModels(names: string[]): string[] {
  const parsed = names
    .map((name) => name.replace(/^models\//, ""))
    .filter((name) => /^gemini-[\d.]+-flash/.test(name) && !/(image|tts|live|audio|embedding|thinking-exp|robotics|computer)/.test(name))
    .map((name) => {
      const version = name.match(/^gemini-([\d.]+)-/)?.[1] ?? "0";
      return { name, version: version.split(".").map(Number), lite: /lite/.test(name), preview: /preview|exp/.test(name) };
    });
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
    return 0;
  };
  parsed.sort((a, b) => Number(a.lite) - Number(b.lite) || compare(a.version, b.version) || Number(a.preview) - Number(b.preview) || a.name.localeCompare(b.name));
  return [...new Set(parsed.map((p) => p.name))];
}

export interface GeminiOptions {
  secrets: SecretStore;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  clock?: () => number;
}

export class GeminiUrlRung implements VideoRung {
  readonly id = "gemini";
  readonly label = "Gemini reads the video by its address";
  private readonly secrets: SecretStore;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => number;
  private models: { at: number; names: string[] } | null = null;
  private pausedUntil = 0;

  constructor(options: GeminiOptions) {
    this.secrets = options.secrets;
    this.env = options.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  appliesTo(target: VideoTarget): boolean {
    return target.tier === "public";
  }

  private async key(): Promise<string | undefined> {
    const named = this.env["JUHANDU_GEMINI_KEY"];
    if (named) return named;
    return (await this.secrets.get("gemini_api_key")) ?? (await this.secrets.get("gemini/key"));
  }

  async unavailable(): Promise<string | null> {
    if (this.env["JUHANDU_GEMINI"] === "off") return "Switched off (JUHANDU_GEMINI=off)";
    if (this.clock() < this.pausedUntil) return "Paused for an hour after Google refused the key";
    return (await this.key()) ? null : "No Gemini key is stored (set JUHANDU_GEMINI_KEY or the secret gemini_api_key)";
  }

  /** The Flash models the key can use, newest first. The list is asked for once every few hours; if Google cannot be asked, the last known releases are used. */
  async modelList(key: string): Promise<string[]> {
    const override = this.env["JUHANDU_GEMINI_MODELS"]?.split(",").map((s) => s.trim()).filter(Boolean);
    if (override?.length) return override;
    if (this.models && this.clock() - this.models.at < MODEL_LIST_TTL_MS) return this.models.names;
    let names = FALLBACK_MODELS;
    try {
      const response = await this.fetchImpl(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        const body = (await response.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
        const usable = (body.models ?? []).filter((m) => m.name && (m.supportedGenerationMethods ?? []).includes("generateContent")).map((m) => m.name as string);
        const ordered = orderModels(usable);
        if (ordered.length) names = ordered;
      }
    } catch {
      // The fixed list below still works.
    }
    this.models = { at: this.clock(), names };
    return names;
  }

  async read(target: VideoTarget): Promise<VideoReading> {
    const key = await this.key();
    if (!key) throw new RungSkipped("No Gemini key");
    const address = watchUrl(target.videoId);
    const failures: string[] = [];
    for (const model of await this.modelList(key)) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${API}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ file_data: { file_uri: address } }, { text: PROMPT }] }] }),
          signal: AbortSignal.timeout(300_000),
        });
      } catch (error) {
        failures.push(`${model}: ${(error as Error).message}`);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        this.pausedUntil = this.clock() + KEY_COOLDOWN_MS;
        throw new RungSkipped(`Google refused the key (${response.status})`);
      }
      if (response.status === 404 || response.status === 429 || response.status >= 500) {
        failures.push(`${model}: ${response.status}`);
        continue;
      }
      if (!response.ok) throw new RungFailed(`Gemini rejected the video (${response.status}): ${(await response.text()).slice(0, 200).replace(/\s+/g, " ")}`);
      const body = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").replace(/[*_`#]+/g, "").trim();
      if (!text) {
        failures.push(`${model}: empty answer`);
        continue;
      }
      return { text: clip(text, MAX_TEXT_CHARS), rung: this.id, model };
    }
    throw new RungFailed(`No Gemini model could read it (${failures.join("; ") || "no models"})`);
  }
}
