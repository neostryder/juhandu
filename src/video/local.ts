// The third rung: the app takes the video apart itself. yt-dlp and ffmpeg fetch the audio and a few frames; a speech-to-text endpoint writes the words; an optional vision endpoint describes the frames; a local model digests both. It works with any OpenAI-style speech and vision server, local or hosted, and a private-tier video only ever goes to endpoints the egress gate allows.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGate } from "../models/egress.ts";
import type { OpenAIEndpoint } from "../models/openai.ts";
import { authHeaders, joinUrl } from "../models/openai.ts";
import type { ModelProvider } from "../models/provider.ts";
import { endpointFrom } from "../models/setup.ts";
import type { FetchLike } from "../sources/fetcher.ts";
import { digestTranscript } from "./digest.ts";
import { ProgramFinder, runCommand } from "./exec.ts";
import type { Command } from "./exec.ts";
import { watchUrl } from "./ids.ts";
import { clip, formatTime } from "./transcript.ts";
import { RungFailed, RungSkipped } from "./types.ts";
import type { VideoReading, VideoRung, VideoTarget } from "./types.ts";

/** Longer videos are left to the other rungs; a full speech pass over them would hold the machine for too long. */
const MAX_DURATION_SEC = 3_600;
/** Speech servers commonly refuse bodies over 25 MB. */
const MAX_AUDIO_BYTES = 24_000_000;
const DEFAULT_FRAMES = 12;

export interface MediaEndpoints {
  transcribe: OpenAIEndpoint | null;
  vision: OpenAIEndpoint | null;
  gate: EgressGate;
}

export function mediaEndpointsFrom(env: Record<string, string | undefined>): MediaEndpoints {
  return {
    transcribe: endpointFrom(env, "JUHANDU_TRANSCRIBE", "transcription", "whisper-1"),
    vision: endpointFrom(env, "JUHANDU_VISION", "vision", "default"),
    gate: new EgressGate(env["JUHANDU_PRIVATE_ALLOW"]?.split(",").map((s) => s.trim()).filter(Boolean)),
  };
}

export interface Segment {
  startSec: number;
  text: string;
}

/** Reads an OpenAI-style transcription answer: timed segments when the server gives them, otherwise the whole text as one segment. */
export function parseTranscription(body: { text?: string; segments?: { start?: number; text?: string }[] }): Segment[] {
  const segments = (body.segments ?? []).filter((s) => typeof s.start === "number" && s.text?.trim()).map((s) => ({ startSec: s.start as number, text: (s.text as string).replace(/\s+/g, " ").trim() }));
  if (segments.length) return segments;
  const text = body.text?.replace(/\s+/g, " ").trim();
  return text ? [{ startSec: 0, text }] : [];
}

export function mergeTimeline(speech: Segment[], screen: Segment[], groupSec = 20): string {
  const lines: { at: number; text: string }[] = [];
  let start = -Infinity;
  let words: string[] = [];
  const flush = () => {
    if (words.length) lines.push({ at: start, text: `[${formatTime(start)}] ${words.join(" ")}` });
    words = [];
  };
  for (const s of speech) {
    if (s.startSec - start >= groupSec) {
      flush();
      start = s.startSec;
    }
    words.push(s.text);
  }
  flush();
  for (const s of screen) lines.push({ at: s.startSec, text: `[${formatTime(s.startSec)}] ON SCREEN: ${s.text}` });
  lines.sort((a, b) => a.at - b.at);
  return lines.map((l) => l.text).join("\n");
}

export interface LocalOptions {
  env: Record<string, string | undefined>;
  provider: ModelProvider | null;
  endpoints: MediaEndpoints;
  run?: Command;
  finder?: ProgramFinder;
  fetchImpl?: FetchLike;
}

export class AppSideRung implements VideoRung {
  readonly id = "local";
  readonly label = "The app extracts speech and frames, and a local model digests them";
  private readonly env: Record<string, string | undefined>;
  private readonly provider: ModelProvider | null;
  private readonly endpoints: MediaEndpoints;
  private readonly run: Command;
  private readonly finder: ProgramFinder;
  private readonly fetchImpl: FetchLike;

  constructor(options: LocalOptions) {
    this.env = options.env;
    this.provider = options.provider;
    this.endpoints = options.endpoints;
    this.run = options.run ?? runCommand;
    this.finder = options.finder ?? new ProgramFinder(this.run);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  appliesTo(target: VideoTarget): boolean {
    const wanted = [this.endpoints.transcribe, this.endpoints.vision].filter((e): e is OpenAIEndpoint => Boolean(e));
    return wanted.some((e) => this.endpoints.gate.allows(target.tier, e));
  }

  async unavailable(): Promise<string | null> {
    if (!this.endpoints.transcribe && !this.endpoints.vision) return "No speech or vision server is set up yet.";
    if (!(await this.finder.find("yt-dlp", this.env["JUHANDU_YTDLP"]))) return "yt-dlp is not installed on the server.";
    if (!(await this.finder.find("ffmpeg", this.env["JUHANDU_FFMPEG"], "-version"))) return "ffmpeg is not installed on the server.";
    return null;
  }

  private allowed(target: VideoTarget, endpoint: OpenAIEndpoint | null): OpenAIEndpoint | null {
    return endpoint && this.endpoints.gate.allows(target.tier, endpoint) ? endpoint : null;
  }

  private async speech(endpoint: OpenAIEndpoint, folder: string, program: { ytdlp: string; ffmpeg: string }, target: VideoTarget): Promise<Segment[]> {
    const raw = await this.run(program.ytdlp, ["--no-playlist", "--no-warnings", "-f", "bestaudio", "-o", "audio.%(ext)s", watchUrl(target.videoId)], { cwd: folder, timeoutMs: 600_000 });
    const source = (await readdir(folder)).find((n) => n.startsWith("audio."));
    if (!source) throw new RungFailed(`Could not fetch the audio (${raw.stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "no output"})`);
    const converted = await this.run(program.ffmpeg, ["-y", "-loglevel", "error", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "speech.mp3"], { cwd: folder, timeoutMs: 600_000 });
    if (converted.code !== 0) throw new RungFailed("ffmpeg could not convert the audio");
    const bytes = await readFile(join(folder, "speech.mp3"));
    if (bytes.length > MAX_AUDIO_BYTES) throw new RungFailed("The audio is too large for the speech server");
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: "audio/mpeg" }), "speech.mp3");
    form.set("model", endpoint.model);
    form.set("response_format", "verbose_json");
    const headers = authHeaders(endpoint.apiKey);
    delete headers["content-type"];
    const response = await this.fetchImpl(joinUrl(endpoint.baseUrl, "/audio/transcriptions"), { method: "POST", headers, body: form, signal: AbortSignal.timeout(endpoint.timeoutMs ?? 900_000) });
    if (!response.ok) throw new RungFailed(`The speech server answered ${response.status}`);
    return parseTranscription((await response.json()) as Parameters<typeof parseTranscription>[0]);
  }

  private async frames(endpoint: OpenAIEndpoint, folder: string, program: { ytdlp: string; ffmpeg: string }, target: VideoTarget, duration: number): Promise<Segment[]> {
    const count = Math.max(1, Math.min(Number(this.env["JUHANDU_VIDEO_FRAMES"] ?? DEFAULT_FRAMES), 40));
    const fetched = await this.run(program.ytdlp, ["--no-playlist", "--no-warnings", "-f", "bv*[height<=480]/b[height<=480]/worst", "-o", "clip.%(ext)s", watchUrl(target.videoId)], { cwd: folder, timeoutMs: 600_000 });
    const clipFile = (await readdir(folder)).find((n) => n.startsWith("clip."));
    if (!clipFile) throw new RungFailed(`Could not fetch the picture (${fetched.stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "no output"})`);
    const rate = `${count}/${Math.max(duration, count)}`;
    const cut = await this.run(program.ffmpeg, ["-y", "-loglevel", "error", "-i", clipFile, "-vf", `fps=${rate},scale=640:-2`, "-frames:v", String(count), "frame-%03d.jpg"], { cwd: folder, timeoutMs: 600_000 });
    if (cut.code !== 0) throw new RungFailed("ffmpeg could not cut frames");
    const names = (await readdir(folder)).filter((n) => /^frame-\d+\.jpg$/.test(n)).sort();
    const out: Segment[] = [];
    for (let i = 0; i < names.length; i++) {
      const image = (await readFile(join(folder, names[i] as string))).toString("base64");
      const response = await this.fetchImpl(joinUrl(endpoint.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: authHeaders(endpoint.apiKey),
        body: JSON.stringify({
          model: endpoint.model,
          temperature: 0.1,
          max_tokens: 200,
          messages: [{ role: "user", content: [{ type: "text", text: "In two sentences, say what this video frame shows. Copy any readable on-screen text exactly. Do not guess what is not visible." }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } }] }],
        }),
        signal: AbortSignal.timeout(endpoint.timeoutMs ?? 120_000),
      });
      if (!response.ok) continue;
      const text = ((await response.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content?.replace(/\s+/g, " ").trim();
      if (text) out.push({ startSec: (i + 0.5) * (duration / Math.max(names.length, 1)), text: clip(text, 400) });
    }
    return out;
  }

  async read(target: VideoTarget): Promise<VideoReading> {
    const transcribe = this.allowed(target, this.endpoints.transcribe);
    const vision = this.allowed(target, this.endpoints.vision);
    if (!transcribe && !vision) throw new RungSkipped("No speech or vision server may receive this video");
    const ytdlp = await this.finder.find("yt-dlp", this.env["JUHANDU_YTDLP"]);
    const ffmpeg = await this.finder.find("ffmpeg", this.env["JUHANDU_FFMPEG"], "-version");
    if (!ytdlp || !ffmpeg) throw new RungSkipped(!ytdlp ? "yt-dlp is not installed" : "ffmpeg is not installed");
    const program = { ytdlp, ffmpeg };
    const probe = await this.run(ytdlp, ["--no-playlist", "--no-warnings", "--skip-download", "--print", "DURATION=%(duration)s", watchUrl(target.videoId)], { timeoutMs: 60_000 });
    const duration = Number(probe.stdout.match(/DURATION=(\d+(?:\.\d+)?)/)?.[1]);
    if (!Number.isFinite(duration)) throw new RungFailed("Could not learn how long the video is (a live stream or an unavailable video)");
    if (duration > MAX_DURATION_SEC) throw new RungFailed(`The video is ${Math.round(duration / 60)} minutes long, over the ${MAX_DURATION_SEC / 60}-minute limit for this rung`);
    const folder = await mkdtemp(join(tmpdir(), "juhandu-video-"));
    try {
      let speech: Segment[] = [];
      let screen: Segment[] = [];
      if (transcribe) speech = await this.speech(transcribe, folder, program, target);
      if (vision) screen = await this.frames(vision, folder, program, target, duration).catch((error: unknown) => {
        if (!transcribe) throw error;
        return [];
      });
      if (!speech.length && !screen.length) throw new RungFailed("Nothing could be read from the speech or the pictures");
      const timeline = mergeTimeline(speech, screen);
      const digest = await digestTranscript(this.provider, { title: target.title, transcript: timeline, tier: target.tier });
      return { text: digest.text, transcript: timeline, rung: this.id, model: digest.model, durationSec: duration };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }
}
