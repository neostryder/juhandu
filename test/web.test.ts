import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/server.ts";
import { stampVersion, VERSION_MARK, WebAssets } from "../src/api/assets.ts";
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
  assert.ok(manifest.shortcuts.length >= 4, "the home-screen icon offers its long-press shortcuts");
  assert.equal(manifest.share_target.method, "GET", "the app appears in the phone's share sheet");
  for (const shortcut of manifest.shortcuts) assert.ok(String(shortcut.url).startsWith(manifest.scope), `${shortcut.name} stays inside the app's scope`);
});

test("the page links the manifest and every script file it imports exists", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  // Behind an access proxy the browser asks for the manifest without the proxy's cookie unless told to send it, and gets a login page instead.
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest" crossorigin="use-credentials"/);
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
  // A phone fetches a linked icon without the proxy's cookie and is sent to a login page, so the icons the page names travel inside it.
  assert.match(html, /rel="apple-touch-icon" href="data:image\/jpeg;base64,/);
  assert.match(html, /rel="icon" type="image\/png" href="data:image\/png;base64,/);
  assert.ok(!/rel="(?:apple-touch-icon|icon)" href="\//.test(html), "no icon is linked by address");
  for (const name of ["app.js", "ui.js", "gestures.js", "briefing.js", "rules.js", "feeds.js", "pipes.js", "watch.js", "connect.js", "setup.js", "login.js"]) {
    for (const [, spec] of readFileSync(join(WEB, name), "utf8").matchAll(/from "\.\/([\w-]+\.js)"|import "\.\/([\w-]+\.js)"|import\("\.\/([\w-]+\.js)"\)/g).map((m) => [m[0], m[1] ?? m[2] ?? m[3]] as const)) {
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
      "/icons/icon-maskable-512.png": "image/png",
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

test("every script and stylesheet address carries the app's version, so an upgrade is fetched past any cache", async () => {
  const folder = mkdtempSync(join(tmpdir(), "juhandu-web-"));
  const store = new Store(join(folder, "db.sqlite"));
  const server = createApp({ store, ingestor: new Ingestor(store), webRoot: WEB, version: "test" });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const version = new WebAssets(WEB).version;
  try {
    assert.match(version, /^[0-9a-f]{12}$/);
    const page = await fetch(base + "/");
    const html = await page.text();
    assert.equal(page.headers.get("cache-control"), "no-cache", "the page is always checked, so it can point at a new version");
    assert.ok(html.includes(`src="/app.js?v=${version}"`), "the page loads the versioned app");
    assert.ok(html.includes(`href="/tokens.css?v=${version}"`), "the page loads the versioned stylesheet");
    assert.ok(html.includes('href="/manifest.webmanifest"'), "the manifest keeps its address");

    const app = await (await fetch(`${base}/app.js?v=${version}`)).text();
    assert.ok(app.includes(`import "./briefing.js?v=${version}"`) && app.includes(`from "./ui.js?v=${version}"`), "every import carries the version");
    assert.ok(app.includes(`register("/sw.js?v=${version}")`), "the service worker is registered under the version");
    assert.ok(!app.includes(VERSION_MARK));
    for (const name of readdirSync(WEB).filter((f) => f.endsWith(".js"))) {
      const text = await (await fetch(`${base}/${name}?v=${version}`)).text();
      assert.ok(!/(?:from|import)\s*"\.\/[\w-]+\.js"/.test(text), `${name} still imports a script without the version`);
    }

    const sw = await fetch(`${base}/sw.js?v=${version}`);
    const swText = await sw.text();
    assert.ok(swText.includes(`const VERSION = "${version}"`), "the service worker knows the version it caches");
    assert.equal(sw.headers.get("cache-control"), "no-cache", "the service worker is always checked");

    assert.equal((await fetch(`${base}/ui.js?v=${version}`)).headers.get("cache-control"), "public, max-age=31536000, immutable", "a versioned script never changes");
    assert.equal((await fetch(`${base}/ui.js`)).headers.get("cache-control"), "no-cache");
    assert.equal((await fetch(`${base}/ui.js?v=000000000000`)).headers.get("cache-control"), "no-cache", "an old version is not kept as if it were the new one");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
    await new Promise((done) => setTimeout(done, 50));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the version changes when any file of the app changes, and stamping leaves other addresses alone", () => {
  const folder = mkdtempSync(join(tmpdir(), "juhandu-assets-"));
  try {
    mkdirSync(join(folder, "icons"));
    writeFileSync(join(folder, "app.js"), 'import "./a.js";\n');
    writeFileSync(join(folder, "icons", "icon.svg"), "<svg/>");
    let now = 0;
    const assets = new WebAssets(folder, () => now);
    const first = assets.version;
    assert.equal(assets.version, first, "nothing changed");
    writeFileSync(join(folder, "icons", "icon.svg"), "<svg></svg>");
    assert.equal(assets.version, first, "the files are not looked at again within a second");
    now += 2_000;
    assert.notEqual(assets.version, first, "a changed file in a subfolder gives a new version");

    assert.equal(stampVersion('<script type="module" src="/app.js"></script><link rel="icon" href="/icons/icon.svg">', ".html", "v1"), '<script type="module" src="/app.js?v=v1"></script><link rel="icon" href="/icons/icon.svg">');
    assert.equal(stampVersion(`import "./a.js";\nimport { b } from "./b.js";\nconst url = "https://example.com/x.js";\nconst v = "${VERSION_MARK}";`, ".js", "v1"), `import "./a.js?v=v1";\nimport { b } from "./b.js?v=v1";\nconst url = "https://example.com/x.js";\nconst v = "v1";`);
    assert.equal(stampVersion(`const load = () => import("./rules.js");\nconst other = () => import( './feeds.js' );`, ".js", "v1"), `const load = () => import("./rules.js?v=v1");\nconst other = () => import( './feeds.js?v=v1' );`, "a module loaded on demand carries the version too");
    assert.equal(stampVersion('<link rel="modulepreload" href="/ui.js">', ".html", "v1"), '<link rel="modulepreload" href="/ui.js?v=v1">');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
