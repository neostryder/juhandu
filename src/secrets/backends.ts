// The secret backends: environment variables, a protected folder, Bitwarden Secrets Manager, and the operating system's own store.
// The OS adapters reach Windows Credential Manager, the macOS Keychain and libsecret by running the system's own tool, so there is no dependency to install.
// A secret value only ever travels on a child process's standard input, never on its command line.
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { redactor, SecretStore } from "./store.ts";
import type { SecretBackend } from "./store.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with an optional stdin and returns what it printed. A missing program rejects. */
export type Run = (file: string, args: string[], options?: { input?: string; env?: Record<string, string> }) => Promise<RunResult>;

export const run: Run = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...options.env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });

function upper(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** JUHANDU_SECRET_<NAME> in the environment. Read only: it is how a container or a service manager hands secrets in. */
export class EnvBackend implements SecretBackend {
  readonly id = "env";
  readonly writable = false;
  private readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined>) {
    this.env = env;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async get(name: string): Promise<string | undefined> {
    return this.env[`JUHANDU_SECRET_${upper(name)}`] || undefined;
  }

  async set(): Promise<void> {
    throw new Error("The environment is read only");
  }

  async delete(): Promise<void> {}
}

/** One owner-only file per secret in a folder. It is the fallback for a machine with no OS store (a container, a server with no desktop session). `aliases` maps a secret name to an older plain file in the same folder, read when no new file exists. */
export class DirBackend implements SecretBackend {
  readonly id = "dir";
  readonly writable = true;
  private readonly dir: string;
  private readonly aliases: Record<string, string>;
  private prepared = false;

  constructor(dir: string, aliases: Record<string, string> = {}) {
    this.dir = dir;
    this.aliases = aliases;
  }

  private file(name: string): string {
    return join(this.dir, `s-${name.replaceAll("/", "%2F")}.secret`);
  }

  private async prepare(): Promise<void> {
    if (this.prepared) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") {
      // Drop inherited permissions and keep the current user only. Best effort: a failure leaves the folder as the data folder's own permissions.
      await run("icacls", [this.dir, "/inheritance:r", "/grant:r", `${userInfo().username}:(OI)(CI)F`]).catch(() => undefined);
    } else {
      await chmod(this.dir, 0o700).catch(() => undefined);
    }
    this.prepared = true;
  }

  async available(): Promise<boolean> {
    await this.prepare();
    return true;
  }

  async get(name: string): Promise<string | undefined> {
    for (const path of [this.file(name), this.aliases[name] ? join(this.dir, this.aliases[name]) : null]) {
      if (!path) continue;
      try {
        const text = (await readFile(path, "utf8")).trim();
        if (text) return text;
      } catch {
        // Missing file: try the next one.
      }
    }
    return undefined;
  }

  async set(name: string, value: string): Promise<void> {
    await this.prepare();
    const path = this.file(name);
    const temp = `${path}.tmp`;
    await writeFile(temp, value, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  }

  async delete(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }
}

/** Bitwarden Secrets Manager through its bws command line. Read only: Juhandu looks a secret up by its name (cogitator/interactive) or by JUHANDU_COGITATOR_INTERACTIVE or plain COGITATOR_INTERACTIVE (so gemini_api_key finds GEMINI_API_KEY), in the project named by JUHANDU_BWS_PROJECT when set. A value would have to go on the command line to be written, so writes are not offered. */
export class BwsBackend implements SecretBackend {
  readonly id = "bws";
  readonly writable = false;
  private readonly env: Record<string, string | undefined>;
  private readonly runner: Run;
  private list: Map<string, string> | null = null;

  constructor(env: Record<string, string | undefined>, runner: Run = run) {
    this.env = env;
    this.runner = runner;
  }

  async available(): Promise<boolean> {
    if (!this.env["BWS_ACCESS_TOKEN"]) return false;
    try {
      return (await this.runner("bws", ["--version"])).code === 0;
    } catch {
      return false;
    }
  }

  private async load(): Promise<Map<string, string>> {
    if (this.list) return this.list;
    const project = this.env["JUHANDU_BWS_PROJECT"];
    const result = await this.runner("bws", ["secret", "list", ...(project ? [project] : []), "--output", "json"]);
    const map = new Map<string, string>();
    if (result.code === 0) {
      for (const entry of JSON.parse(result.stdout) as { key?: unknown; value?: unknown }[]) {
        if (typeof entry.key === "string" && typeof entry.value === "string") map.set(entry.key, entry.value);
      }
    }
    this.list = map;
    return map;
  }

  async get(name: string): Promise<string | undefined> {
    const map = await this.load();
    return map.get(name) ?? map.get(`JUHANDU_${upper(name)}`) ?? map.get(upper(name));
  }

  async set(): Promise<void> {
    throw new Error("Bitwarden is read only here; add the secret in Bitwarden");
  }

  async delete(): Promise<void> {}
}

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class JuhanduCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredWrite(ref CREDENTIAL c, uint flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, byte[] blob) {
    IntPtr p = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, p, blob.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = 1; c.TargetName = target; c.UserName = "juhandu";
      c.CredentialBlobSize = (uint)blob.Length; c.CredentialBlob = p; c.Persist = 2;
      if (!CredWrite(ref c, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(p); }
  }
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) {
      int e = Marshal.GetLastWin32Error();
      if (e == 1168) return null;
      throw new Win32Exception(e);
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, b.Length);
      return b;
    } finally { CredFree(p); }
  }
  public static void Delete(string target) {
    if (!CredDelete(target, 1, 0)) {
      int e = Marshal.GetLastWin32Error();
      if (e != 1168) throw new Win32Exception(e);
    }
  }
}
'@
$op = $env:JUHANDU_CRED_OP
$target = $env:JUHANDU_CRED_TARGET
if ($op -eq 'write') {
  $b64 = [Console]::In.ReadToEnd().Trim()
  [JuhanduCred]::Write($target, [Convert]::FromBase64String($b64))
} elseif ($op -eq 'read') {
  $blob = [JuhanduCred]::Read($target)
  if ($blob -ne $null) { [Console]::Out.Write([Convert]::ToBase64String($blob)) }
} elseif ($op -eq 'delete') {
  [JuhanduCred]::Delete($target)
}
`;

/** Windows Credential Manager's blob limit is 2560 bytes, so a longer secret (a long cookie) falls through to the next backend. */
const WINDOWS_MAX_BYTES = 2560;
const OS_SERVICE = "juhandu";

/** The operating system's credential store: Windows Credential Manager, the macOS Keychain, or libsecret (secret-tool) on Linux. */
export class OsBackend implements SecretBackend {
  readonly id = "os";
  readonly writable = true;
  private readonly runner: Run;
  private readonly platform: NodeJS.Platform;

  constructor(runner: Run = run, platform: NodeJS.Platform = process.platform) {
    this.runner = runner;
    this.platform = platform;
  }

  private async windows(op: "read" | "write" | "delete", name: string, input = ""): Promise<RunResult> {
    const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    const env = { JUHANDU_CRED_OP: op, JUHANDU_CRED_TARGET: `${OS_SERVICE}:${name}` };
    try {
      return await this.runner("pwsh", args, { input, env });
    } catch {
      return await this.runner("powershell", args, { input, env });
    }
  }

  async available(): Promise<boolean> {
    try {
      if (this.platform === "win32") return (await this.windows("read", "probe")).code === 0;
      if (this.platform === "darwin") {
        const probe = await this.runner("security", ["find-generic-password", "-s", OS_SERVICE, "-a", "probe"]);
        return probe.code === 0 || probe.code === 44;
      }
      const probe = await this.runner("secret-tool", ["lookup", "service", OS_SERVICE, "account", "probe"]);
      return probe.code === 0 || (probe.code === 1 && !probe.stderr.trim());
    } catch {
      return false;
    }
  }

  async get(name: string): Promise<string | undefined> {
    if (this.platform === "win32") {
      const result = await this.windows("read", name);
      if (result.code !== 0) throw new Error("Credential Manager read failed");
      const text = result.stdout.trim();
      return text ? Buffer.from(text, "base64").toString("utf8") : undefined;
    }
    if (this.platform === "darwin") {
      const result = await this.runner("security", ["find-generic-password", "-s", OS_SERVICE, "-a", name, "-w"]);
      if (result.code === 44) return undefined;
      if (result.code !== 0) throw new Error("Keychain read failed");
      return result.stdout.replace(/\r?\n$/, "") || undefined;
    }
    const result = await this.runner("secret-tool", ["lookup", "service", OS_SERVICE, "account", name]);
    if (result.code !== 0) return undefined;
    return result.stdout || undefined;
  }

  async set(name: string, value: string): Promise<void> {
    if (this.platform === "win32") {
      const blob = Buffer.from(value, "utf8");
      if (blob.length > WINDOWS_MAX_BYTES) throw new Error("Too long for Credential Manager");
      const result = await this.windows("write", name, blob.toString("base64"));
      if (result.code !== 0) throw new Error("Credential Manager write failed");
      return;
    }
    if (this.platform === "darwin") {
      // security -i reads its command from stdin, so the value (as hex) is not on the command line.
      const hex = Buffer.from(value, "utf8").toString("hex");
      const result = await this.runner("security", ["-i"], { input: `add-generic-password -U -s ${OS_SERVICE} -a ${name} -X ${hex}\n` });
      if (result.code !== 0) throw new Error("Keychain write failed");
      return;
    }
    const result = await this.runner("secret-tool", ["store", `--label=Juhandu ${name}`, "service", OS_SERVICE, "account", name], { input: value });
    if (result.code !== 0) throw new Error("libsecret write failed");
  }

  async delete(name: string): Promise<void> {
    if (this.platform === "win32") {
      await this.windows("delete", name);
    } else if (this.platform === "darwin") {
      await this.runner("security", ["delete-generic-password", "-s", OS_SERVICE, "-a", name]);
    } else {
      await this.runner("secret-tool", ["clear", "service", OS_SERVICE, "account", name]);
    }
  }
}

/** The default order is env, bws, os, dir. JUHANDU_SECRETS=env,dir narrows or reorders it. Writes go to the first writable backend that works (os, then dir). */
export function buildSecretStore(env: Record<string, string | undefined>, dataDir: string): { store: SecretStore; notes: string[] } {
  const wanted = (env["JUHANDU_SECRETS"] ?? "env,bws,os,dir").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const dir = env["JUHANDU_SECRETS_DIR"] ?? join(dataDir, "secrets");
  const backends: SecretBackend[] = [];
  const notes: string[] = [];
  for (const id of wanted) {
    if (id === "env") backends.push(new EnvBackend(env));
    else if (id === "bws") backends.push(new BwsBackend(env));
    else if (id === "os") backends.push(new OsBackend());
    else if (id === "dir") backends.push(new DirBackend(dir, { "cogitator/interactive": "interactive.key", "cogitator/background": "background.key" }));
    else notes.push(`JUHANDU_SECRETS names an unknown backend "${id}"; it is ignored.`);
  }
  return { store: new SecretStore(backends, redactor), notes };
}
