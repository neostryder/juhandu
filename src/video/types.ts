// The VideoReader ladder: ways of turning a video into text, tried in order. A rung that does not apply or is not set up is skipped; a rung that tries and fails hands over to the next.
import type { DataTier } from "../store/store.ts";

export interface VideoTarget {
  itemId: number;
  /** The address of the video page, as the feed gave it. */
  url: string;
  videoId: string;
  title: string;
  tier: DataTier;
}

export interface VideoReading {
  /** What the video says and shows: a gist, timestamped highlights and anything shown but not spoken. Written in prose, ready for the summarizer. */
  text: string;
  /** The words spoken, with timestamps, when a rung had them. */
  transcript?: string;
  /** Which rung read it: gemini, captions or local. */
  rung: string;
  /** The model that wrote or digested the text, or "captions" when the text is the captions themselves. */
  model: string;
  durationSec?: number;
}

/** The rung does not apply to this video or is not set up, so nothing was tried. */
export class RungSkipped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RungSkipped";
  }
}

/** The rung tried and could not read this video. The next rung gets its turn. */
export class RungFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RungFailed";
  }
}

export interface VideoRung {
  readonly id: string;
  readonly label: string;
  /** Whether this rung may be tried for the video at all (for example, a private-tier video never goes to a hosted service). */
  appliesTo(target: VideoTarget): boolean;
  /** Null when the rung is ready, otherwise the plain reason it is not (a missing key or program). */
  unavailable(): Promise<string | null>;
  read(target: VideoTarget): Promise<VideoReading>;
}

export interface RungStatus {
  id: string;
  label: string;
  ready: boolean;
  /** Why it is not ready. */
  reason: string;
  /** True when the last Test of this way failed, in which case reason says what the Test found. */
  failed?: boolean;
}
