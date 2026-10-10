// The VideoReader ladder: each shown video item goes down the rungs in order until one reads it. A reading is stored beside the item and the summarizer uses it in place of the feed's few words about the video.
import { NoEndpointError } from "../models/pool.ts";
import type { PendingItem, Store } from "../store/store.ts";
import { youtubeVideoId } from "./ids.ts";
import { RungFailed, RungSkipped } from "./types.ts";
import type { RungStatus, VideoRung, VideoTarget } from "./types.ts";

export interface VideoRun {
  read: number;
  none: number;
  failed: number;
  /** Items left waiting because no model could take them. */
  queued: number;
}

type Outcome = { kind: "ok" } | { kind: "none"; note: string } | { kind: "failed"; note: string };

export class VideoReader {
  private readonly rungs: VideoRung[];
  private readonly store: Store;
  private readonly clock: () => Date;

  constructor(rungs: VideoRung[], store: Store, clock: () => Date = () => new Date()) {
    this.rungs = rungs;
    this.store = store;
    this.clock = clock;
  }

  /** Which rungs can work right now, and why the others cannot. */
  async status(): Promise<RungStatus[]> {
    const out: RungStatus[] = [];
    for (const rung of this.rungs) {
      const reason = await rung.unavailable().catch((error: unknown) => (error as Error).message);
      out.push({ id: rung.id, label: rung.label, ready: reason === null, reason: reason ?? "" });
    }
    return out;
  }

  async anyReady(): Promise<boolean> {
    return (await this.status()).some((r) => r.ready);
  }

  private async read(item: PendingItem): Promise<Outcome> {
    const videoId = youtubeVideoId(item.url);
    if (!videoId) return { kind: "none", note: "The address is not a single YouTube video" };
    const target: VideoTarget = { itemId: item.id, url: item.url, videoId, title: item.title, tier: item.tier };
    const notes: string[] = [];
    let tried = 0;
    for (const rung of this.rungs) {
      if (!rung.appliesTo(target)) {
        notes.push(`${rung.id}: not for ${item.tier} items`);
        continue;
      }
      const reason = await rung.unavailable().catch((error: unknown) => (error as Error).message);
      if (reason !== null) {
        notes.push(`${rung.id}: ${reason}`);
        continue;
      }
      tried++;
      try {
        const reading = await rung.read(target);
        this.store.saveVideoReading(item.id, { status: "ok", rung: reading.rung, model: reading.model, text: reading.text, transcript: reading.transcript ?? "", ...(reading.durationSec !== undefined ? { durationSec: reading.durationSec } : {}) }, this.clock());
        return { kind: "ok" };
      } catch (error) {
        if (error instanceof NoEndpointError) throw error;
        if (error instanceof RungSkipped) {
          tried--;
          notes.push(`${rung.id}: ${error.message}`);
        } else if (error instanceof RungFailed) notes.push(`${rung.id}: ${error.message}`);
        else notes.push(`${rung.id}: ${(error as Error).message}`);
      }
    }
    const note = notes.join("; ").slice(0, 600);
    return tried > 0 ? { kind: "failed", note } : { kind: "none", note };
  }

  /** Reads the newest unread video items. Stops at the first sign that no model is available, leaving the rest queued. */
  async run(limit = 3): Promise<VideoRun> {
    const out: VideoRun = { read: 0, none: 0, failed: 0, queued: 0 };
    // With no rung set up the items stay unread, so adding yt-dlp or a key later reaches the whole backlog.
    if (!(await this.anyReady())) return out;
    const pending = this.store.itemsNeedingVideo(limit, this.clock());
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i] as PendingItem;
      try {
        const outcome = await this.read(item);
        if (outcome.kind === "ok") out.read++;
        else {
          this.store.saveVideoReading(item.id, { status: outcome.kind, note: outcome.note }, this.clock());
          if (outcome.kind === "none") out.none++;
          else out.failed++;
        }
      } catch (error) {
        if (!(error instanceof NoEndpointError)) throw error;
        out.queued = pending.length - i;
        break;
      }
    }
    return out;
  }
}
