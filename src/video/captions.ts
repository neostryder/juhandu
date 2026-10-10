// The second rung: the video's own captions, fetched with yt-dlp, then a local model's digest of them. Works for any tier, because the captions come from the site and the digest from a local model.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "../models/provider.ts";
import { digestTranscript } from "./digest.ts";
import { ProgramFinder, runCommand } from "./exec.ts";
import type { Command } from "./exec.ts";
import { watchUrl } from "./ids.ts";
import { cuesToTranscript, parseJson3 } from "./transcript.ts";
import { RungFailed, RungSkipped } from "./types.ts";
import type { VideoReading, VideoRung, VideoTarget } from "./types.ts";

/** Fewer words than this is a stub or a music video, not a transcript worth digesting. */
const MIN_TRANSCRIPT_CHARS = 200;

export interface CaptionsOptions {
  env: Record<string, string | undefined>;
  provider: ModelProvider | null;
  run?: Command;
  finder?: ProgramFinder;
}

export class CaptionsRung implements VideoRung {
  readonly id = "captions";
  readonly label = "The video's captions, digested by a local model";
  private readonly env: Record<string, string | undefined>;
  private readonly provider: ModelProvider | null;
  private readonly run: Command;
  private readonly finder: ProgramFinder;

  constructor(options: CaptionsOptions) {
    this.env = options.env;
    this.provider = options.provider;
    this.run = options.run ?? runCommand;
    this.finder = options.finder ?? new ProgramFinder(this.run);
  }

  appliesTo(): boolean {
    return true;
  }

  async unavailable(): Promise<string | null> {
    return (await this.finder.find("yt-dlp", this.env["JUHANDU_YTDLP"])) ? null : "yt-dlp is not installed (install it, or set JUHANDU_YTDLP to its path)";
  }

  async read(target: VideoTarget): Promise<VideoReading> {
    const program = await this.finder.find("yt-dlp", this.env["JUHANDU_YTDLP"]);
    if (!program) throw new RungSkipped("yt-dlp is not installed");
    const folder = await mkdtemp(join(tmpdir(), "juhandu-video-"));
    try {
      const languages = this.env["JUHANDU_VIDEO_LANGS"] ?? "en.*,en";
      const result = await this.run(
        program,
        ["--skip-download", "--no-playlist", "--write-subs", "--write-auto-subs", "--sub-langs", languages, "--sub-format", "json3", "--print", "DURATION=%(duration)s", "--no-simulate", "--no-warnings", "-o", "%(id)s", watchUrl(target.videoId)],
        { cwd: folder, timeoutMs: 120_000 },
      );
      // A second language track can fail with a rate limit while the first one arrived, so the files decide, not the exit code.
      const files = (await readdir(folder)).filter((name) => name.endsWith(".json3")).sort();
      let best = { transcript: "", cues: 0 };
      for (const name of files) {
        const cues = parseJson3(await readFile(join(folder, name), "utf8"));
        if (cues.length > best.cues) best = { transcript: cuesToTranscript(cues), cues: cues.length };
      }
      if (best.transcript.length < MIN_TRANSCRIPT_CHARS) {
        throw new RungFailed(files.length ? "The captions are too short to read" : `No captions (${result.stderr.trim().split("\n").at(-1)?.slice(0, 160) ?? "yt-dlp found none"})`);
      }
      const duration = Number(result.stdout.match(/DURATION=(\d+(?:\.\d+)?)/)?.[1]);
      const digest = await digestTranscript(this.provider, { title: target.title, transcript: best.transcript, tier: target.tier });
      return { text: digest.text, transcript: best.transcript, rung: this.id, model: digest.model, ...(Number.isFinite(duration) ? { durationSec: duration } : {}) };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }
}
