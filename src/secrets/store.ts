// The SecretStore seam. Every credential Juhandu holds goes through it: feed logins, private feed URLs, model keys.
// Secret values are never put in the database, the API, or a log line. The adapters live beside this file.

/** Names are lowercase words joined by . _ - and /, such as "cogitator/interactive" or "source/12". */
const NAME = /^[a-z0-9][a-z0-9._/-]{0,119}$/;

export function assertSecretName(name: string): void {
  if (!NAME.test(name) || name.includes("..") || name.includes("//") || name.endsWith("/")) throw new Error(`Not a valid secret name: ${name}`);
}

export interface SecretBackend {
  /** Short id used in config and status: env, bws, os, dir. */
  readonly id: string;
  readonly writable: boolean;
  /** True when this backend can be used on this machine right now (a tool is installed, a folder can be made). */
  available(): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  /** Only called on writable backends. */
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Removes known secret values from text before it is stored or logged. */
export class Redactor {
  private values = new Set<string>();

  add(value: string): void {
    // Very short values would shred ordinary text, so they are not tracked.
    if (value.length >= 6) this.values.add(value);
  }

  apply(text: string): string {
    let out = text;
    for (const value of [...this.values].sort((a, b) => b.length - a.length)) out = out.split(value).join("[secret]");
    return out;
  }
}

/** The process-wide redactor: the chain registers every secret it reads or writes, and error paths run text through it. */
export const redactor = new Redactor();

export interface SecretStatus {
  id: string;
  writable: boolean;
  available: boolean;
}

/** Reads check each backend in order; writes go to the first writable backend that accepts the value. Values are cached in memory so a poll never shells out. */
export class SecretStore {
  private readonly backends: SecretBackend[];
  private readonly cache = new Map<string, string | undefined>();
  /** Which backend each cached value came from, so a screen can tell a value it may replace from one the server hands in. */
  private readonly origins = new Map<string, string>();
  private readonly redact_: Redactor;
  private usable: Map<string, boolean> | null = null;

  constructor(backends: SecretBackend[], redact: Redactor = redactor) {
    this.backends = backends;
    this.redact_ = redact;
  }

  private async usableBackends(): Promise<SecretBackend[]> {
    if (!this.usable) {
      this.usable = new Map();
      for (const backend of this.backends) this.usable.set(backend.id, await safe(() => backend.available(), false));
    }
    return this.backends.filter((b) => this.usable?.get(b.id));
  }

  async status(): Promise<SecretStatus[]> {
    await this.usableBackends();
    return this.backends.map((b) => ({ id: b.id, writable: b.writable, available: this.usable?.get(b.id) ?? false }));
  }

  async get(name: string): Promise<string | undefined> {
    assertSecretName(name);
    if (this.cache.has(name)) return this.cache.get(name);
    for (const backend of await this.usableBackends()) {
      const value = await safe(() => backend.get(name), undefined);
      if (value !== undefined && value !== "") {
        this.redact_.add(value);
        this.cache.set(name, value);
        this.origins.set(name, backend.id);
        return value;
      }
    }
    return undefined;
  }

  /** Starts removing a value from redacted text. A JSON secret's inner values (a link, a password) are tracked this way. */
  track(value: string): void {
    this.redact_.add(value);
  }

  /** Removes every tracked secret value from a piece of text. */
  redact(text: string): string {
    return this.redact_.apply(text);
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  /** Where a secret's value comes from: the backend's id and whether that backend can be written. Undefined when the secret is not set. */
  async origin(name: string): Promise<{ id: string; writable: boolean } | undefined> {
    if ((await this.get(name)) === undefined) return undefined;
    const id = this.origins.get(name);
    const backend = this.backends.find((b) => b.id === id);
    return backend ? { id: backend.id, writable: backend.writable } : undefined;
  }

  /** Stores a secret in the first writable backend that takes it, then removes older copies from the other writable ones so a stale value cannot shadow it. Returns the backend id. */
  async set(name: string, value: string): Promise<string> {
    assertSecretName(name);
    if (!value) throw new Error("A secret cannot be empty");
    // Tracked before any write, so an error from a backend that echoes the value is still scrubbed.
    this.redact_.add(value);
    const writable = (await this.usableBackends()).filter((b) => b.writable);
    let lastError: unknown = new Error("No writable secret backend is available");
    for (const backend of writable) {
      try {
        await backend.set(name, value);
      } catch (error) {
        lastError = error;
        continue;
      }
      for (const other of writable) if (other !== backend) await safe(() => other.delete(name), undefined);
      this.redact_.add(value);
      this.cache.set(name, value);
      this.origins.set(name, backend.id);
      return backend.id;
    }
    throw new Error(`Could not store the secret: ${this.redact_.apply(lastError instanceof Error ? lastError.message : String(lastError))}`);
  }

  async delete(name: string): Promise<void> {
    assertSecretName(name);
    this.cache.delete(name);
    this.origins.delete(name);
    // Every writable backend is tried, and a failure is reported afterward so a secret that is still stored never looks removed.
    let failed = 0;
    for (const backend of (await this.usableBackends()).filter((b) => b.writable)) {
      try {
        await backend.delete(name);
      } catch {
        failed++;
      }
    }
    if (failed) throw new Error("Could not remove the stored secret from every backend");
    // A read-only source such as the environment cannot be cleared from here, and a secret it still provides must not look removed.
    if ((await this.get(name)) !== undefined) throw new Error("The secret is still provided by a source that cannot be changed from here");
  }

  /** A JSON secret (a login is a few fields). Returns undefined when absent or unreadable. */
  async getJson<T>(name: string): Promise<T | undefined> {
    const raw = await this.get(name);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async setJson(name: string, value: unknown): Promise<string> {
    return this.set(name, JSON.stringify(value));
  }

  /** The backends actually in use, for the startup note. */
  async describe(): Promise<string> {
    const status = await this.status();
    return status.map((s) => `${s.id}${s.available ? "" : " (not available)"}${s.writable ? "" : " (read only)"}`).join(", ");
  }
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
