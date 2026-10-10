// Turning captions and timestamps into plain transcript text.

export interface Cue {
  startSec: number;
  text: string;
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** Reads YouTube's json3 caption file. Automatic captions repeat each line as they roll, so a cue that only repeats the one before it is dropped. */
export function parseJson3(body: string): Cue[] {
  let data: { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  try {
    data = JSON.parse(body) as typeof data;
  } catch {
    return [];
  }
  const cues: Cue[] = [];
  for (const event of data.events ?? []) {
    if (!event.segs || typeof event.tStartMs !== "number") continue;
    const text = event.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const previous = cues.at(-1);
    if (previous && (previous.text === text || previous.text.endsWith(text))) continue;
    if (previous && text.startsWith(previous.text)) {
      previous.text = text;
      continue;
    }
    cues.push({ startSec: event.tStartMs / 1000, text });
  }
  return cues;
}

/** One line per cue, grouped into stretches of about `groupSec` seconds so the transcript is readable and short. */
export function cuesToTranscript(cues: Cue[], groupSec = 20): string {
  const lines: string[] = [];
  let start = -Infinity;
  let words: string[] = [];
  const flush = () => {
    if (words.length) lines.push(`[${formatTime(start)}] ${words.join(" ")}`);
    words = [];
  };
  for (const cue of cues) {
    if (cue.startSec - start >= groupSec) {
      flush();
      start = cue.startSec;
    }
    words.push(cue.text);
  }
  flush();
  return lines.join("\n");
}

/** A transcript cut down to roughly `max` characters by keeping evenly spaced slices, so the start, the middle and the end are all represented. */
export function sampleText(text: string, max: number, slices = 8): string {
  if (text.length <= max) return text;
  const size = Math.floor(max / slices);
  const step = (text.length - size) / (slices - 1);
  const parts: string[] = [];
  for (let i = 0; i < slices; i++) parts.push(text.slice(Math.floor(i * step), Math.floor(i * step) + size));
  return parts.join("\n[...]\n");
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}
