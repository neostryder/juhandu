import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Store } from "../src/store/store.ts";
import type { FetchLike } from "../src/sources/fetcher.ts";

const WEB = resolve(import.meta.dirname, "..", "web");

/** Reads the list of cached shell files out of the service worker, so the test follows the file. */
function shellFiles(): string[] {
  const source = readFileSync(join(WEB, "sw.js"), "utf8");
  const match = source.match(/const FILES = (\[[^\]]*\]);/);
  assert.ok(match?.[1], "sw.js lists its shell files in FILES");
  return JSON.parse(match[1]) as string[];
}

test("every file the service worker caches exists in web/, so installing it can not fail", () => {
  for (const file of shellFiles()) {
    const path = file === "/" ? "index.html" : file.slice(1);
    assert.ok(existsSync(join(WEB, path)), `${file} is cached but missing`);
  }
});

test("the manifest is valid and every icon it names exists", () => {
  const manifest = JSON.parse(readFileSync(join(WEB, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.name && manifest.short_name && manifest.start_url && manifest.scope);
  const sizes = new Set<string>();
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(WEB, icon.src.slice(1))), `${icon.src} is named but missing`);
    sizes.add(icon.sizes);
  }
  assert.ok(sizes.has("192x192") && sizes.has("512x512"), "an installable app needs a 192 and a 512 icon");
});

test("the page links the manifest and every script file it imports exists", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
  for (const name of ["app.js", "ui.js", "briefing.js", "rules.js", "feeds.js", "pipes.js", "connect.js", "setup.js", "login.js"]) {
    for (const [, spec] of readFileSync(join(WEB, name), "utf8").matchAll(/from "\.\/([\w-]+\.js)"|import "\.\/([\w-]+\.js)"/g).map((m) => [m[0], m[1] ?? m[2]] as const)) {
      assert.ok(existsSync(join(WEB, spec!)), `${name} imports ./${spec} which is missing`);
    }
  }
});

test("the offline copy lists every script the page loads", () => {
  const sw = readFileSync(join(WEB, "sw.js"), "utf8");
  for (const name of readdirSync(WEB).filter((f) => f.endsWith(".js") && f !== "sw.js")) assert.ok(sw.includes(`"/${name}"`), `sw.js does not cache ${name}`);
});

test("the server sends the manifest, the service worker and the icons with the right types", async () => {
  const folder = mkdtempSync(join(tmpdir(), "juhandu-web-"));
  const store = new Store(join(folder, "db.sqlite"));
  const fetchImpl: FetchLike = async () => {
    throw new Error("no fetching here");
  };
  const server = createApp({ store, ingestor: new Ingestor(store, fetchImpl), fetchImpl, webRoot: WEB, version: "test" });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const expected: Record<string, string> = {
      "/manifest.webmanifest": "application/manifest+json",
      "/sw.js": "text/javascript",
      "/icons/icon-192.png": "image/png",
      "/icons/icon.svg": "image/svg+xml",
      "/": "text/html",
    };
    for (const [path, type] of Object.entries(expected)) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.ok(response.headers.get("content-type")?.startsWith(type), `${path} is ${response.headers.get("content-type")}`);
    }
    const sw = await fetch(base + "/sw.js");
    assert.equal(sw.headers.get("cache-control"), "no-cache", "the service worker must always be revalidated");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    await new Promise((done) => setTimeout(done, 50));
    rmSync(folder, { recursive: true, force: true });
  }
});
