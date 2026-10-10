// Runs the optional outside programs the video rungs use (yt-dlp, ffmpeg). They are found on the PATH or named in the environment; a missing one only switches its rung off.
import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  timeoutMs?: number;
  cwd?: string;
}

/** Runs a program and returns what it printed. A program that is not installed rejects; a program that fails returns its exit code. */
export type Command = (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

const MAX_OUTPUT = 4_000_000;

export const runCommand: Command = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {}) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr: timedOut ? `${stderr}\nTimed out` : stderr });
    });
  });

/** Finds a program: the path named in the environment, else the bare name on the PATH. Returns null when it will not run. Remembered for ten minutes. */
export class ProgramFinder {
  private readonly run: Command;
  private readonly cache = new Map<string, { at: number; path: string | null }>();
  private readonly clock: () => number;

  constructor(run: Command = runCommand, clock: () => number = Date.now) {
    this.run = run;
    this.clock = clock;
  }

  async find(name: string, named: string | undefined, versionFlag = "--version"): Promise<string | null> {
    const key = `${name}|${named ?? ""}`;
    const hit = this.cache.get(key);
    if (hit && this.clock() - hit.at < 600_000) return hit.path;
    const path = named || name;
    let found: string | null = null;
    try {
      const result = await this.run(path, [versionFlag], { timeoutMs: 15_000 });
      found = result.code === 0 ? path : null;
    } catch {
      found = null;
    }
    this.cache.set(key, { at: this.clock(), path: found });
    return found;
  }
}
