// The web app's files. Every script and stylesheet address the app uses carries ?v=<version>, where the version is a hash of the files
// themselves, so a new release is fetched fresh past the browser's cache, the service worker's cache, and any CDN in front of the server.
// A file asked for under the current version never changes, so it may be cached for a year; everything else is checked on every use.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/** Written in a script where the version belongs; replaced when the script is served. */
export const VERSION_MARK = "__JUHANDU_VERSION__";
const FOREVER = "public, max-age=31536000, immutable";
const ALWAYS_CHECK = "no-cache";
/** How long a computed version is trusted before the files are looked at again, so an edit during development shows up. */
const RECHECK_MS = 1_000;

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** A hash of every file under the folder, names included, so any change to the app gives a new version. */
export function versionOf(root: string): string {
  const hash = createHash("sha256");
  for (const file of filesUnder(root)) hash.update(file.slice(root.length)).update("\0").update(readFileSync(file)).update("\0");
  return hash.digest("hex").slice(0, 12);
}

/** Adds the version to every local script and stylesheet address in a page, and to every module import and version mark in a script. */
export function stampVersion(text: string, ext: string, version: string): string {
  if (ext === ".html") return text.replace(/(\s(?:src|href)=")(\/[\w./-]+\.(?:js|css))"/g, `$1$2?v=${version}"`);
  if (ext === ".js") return text.replace(/(\b(?:from|import)\s*["'])(\.\/[\w-]+\.js)(["'])/g, `$1$2?v=${version}$3`).replaceAll(VERSION_MARK, version);
  return text;
}

export interface WebFile {
  data: Buffer | string;
  ext: string;
  cacheControl: string;
}

export class WebAssets {
  readonly root: string;
  private known: { version: string; signature: string; at: number } | null = null;
  private readonly clock: () => number;

  constructor(root: string, clock: () => number = Date.now) {
    this.root = resolve(root);
    this.clock = clock;
  }

  /** The current version. The files' sizes and change times are looked at again at most once a second, and hashed only when they moved. */
  get version(): string {
    const now = this.clock();
    if (this.known && now - this.known.at < RECHECK_MS) return this.known.version;
    const signature = filesUnder(this.root)
      .map((file) => {
        const s = statSync(file);
        return `${file}:${s.size}:${s.mtimeMs}`;
      })
      .join("|");
    if (this.known?.signature !== signature) this.known = { version: versionOf(this.root), signature, at: now };
    else this.known.at = now;
    return this.known.version;
  }

  /** The file for a request path, ready to send, or null when there is none. `asked` is the request's v parameter. */
  async read(pathname: string, asked: string | null): Promise<WebFile | null> {
    let relative: string;
    try {
      relative = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
    } catch {
      return null;
    }
    const full = resolve(join(this.root, relative));
    if (full !== this.root && !full.startsWith(this.root + sep)) return null;
    let raw: Buffer;
    try {
      raw = await readFile(full);
    } catch {
      return null;
    }
    const ext = extname(full);
    const version = this.version;
    const data = ext === ".html" || ext === ".js" ? stampVersion(raw.toString("utf8"), ext, version) : raw;
    // The page and the service worker are always checked, so a new release is seen; any other file under the current version is fixed.
    const fixed = asked === version && ext !== ".html" && full !== join(this.root, "sw.js");
    return { data, ext, cacheControl: fixed ? FOREVER : ALWAYS_CHECK };
  }
}
