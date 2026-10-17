import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateHost, isPrivateName } from "../src/util/network.ts";
import { fetchText } from "../src/sources/fetcher.ts";
import { resolveSource } from "../src/sources/resolve.ts";

test("private and reserved hosts are recognized, public ones are not", () => {
  for (const h of ["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.5", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "::ffff:127.0.0.1", "fd12::1", "fe80::1", "nas", "printer.local", "db.internal", "2130706433"]) {
    assert.equal(isPrivateHost(new URL(h.includes(":") && !h.startsWith("[") ? `http://[${h}]/` : `http://${h}/`).hostname), true, h);
  }
  for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateHost(new URL(h.includes(":") ? `http://[${h}]/` : `http://${h}/`).hostname), false, h);
  }
});

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

test("a public address cannot redirect a fetch onto a private one", async () => {
  const seen: string[] = [];
  const fake = async (url: string) => {
    seen.push(url);
    return redirect("http://169.254.169.254/latest/meta-data/");
  };
  await assert.rejects(() => fetchText("https://example.com/feed", {}, fake), /private/);
  assert.deepEqual(seen, ["https://example.com/feed"]);
});

test("redirects between public addresses are followed and report the final address", async () => {
  const fake = async (url: string) => (url === "https://example.com/a" ? redirect("https://example.org/b") : new Response("ok", { status: 200 }));
  const result = await fetchText("https://example.com/a", {}, fake);
  assert.equal(result.finalUrl, "https://example.org/b");
  assert.equal(result.body, "ok");
});

test("an address the reader typed on a private network still works", async () => {
  const fake = async () => new Response("ok", { status: 200 });
  assert.equal((await fetchText("http://192.168.1.5:8080/feed", {}, fake)).body, "ok");
});

test("autodiscovery on a public page skips feed links that point at a private address", async () => {
  const page = '<html><head><link rel="alternate" type="application/rss+xml" href="http://127.0.0.1:9000/feed"></head></html>';
  const asked: string[] = [];
  const fake = async (url: string) => {
    asked.push(url);
    return url === "https://example.com/" ? new Response(page, { status: 200 }) : new Response("", { status: 404 });
  };
  await assert.rejects(() => resolveSource("https://example.com/", fake), /No feed found/);
  assert.equal(
    asked.some((u) => u.includes("127.0.0.1")),
    false,
  );
});

test("a name that resolves to a private address counts as private, and one that does not resolve is left to fail on its own", async () => {
  const table: Record<string, string[]> = { "10.0.0.1.nip.io": ["10.0.0.1"], "rebind.example": ["93.184.216.34", "169.254.169.254"], "ok.example": ["93.184.216.34"], "v6.example": ["fd00::1"] };
  const resolve = async (host: string) => {
    const found = table[host];
    if (!found) throw new Error("ENOTFOUND");
    return found;
  };
  assert.equal(await isPrivateName("10.0.0.1.nip.io", resolve), true);
  assert.equal(await isPrivateName("rebind.example", resolve), true, "one private address among several is enough");
  assert.equal(await isPrivateName("v6.example", resolve), true);
  assert.equal(await isPrivateName("ok.example", resolve), false);
  assert.equal(await isPrivateName("missing.example", resolve), false);
  assert.equal(await isPrivateName("localhost", resolve), true, "a reserved name never needs a lookup");
  assert.equal(await isPrivateName("8.8.8.8", async () => ["127.0.0.1"]), false, "a literal address is judged as written");
  assert.equal(await isPrivateName("ok.example", undefined), false);
});

test("a redirect to a name that resolves to a private address is stopped, and a private start may follow it", async () => {
  const resolve = async (host: string) => (host === "internal.example.com" ? ["10.1.1.1"] : ["93.184.216.34"]);
  const fake = async (url: string) => (url.startsWith("https://start.") ? redirect("https://internal.example.com/feed") : new Response("ok", { status: 200 }));
  await assert.rejects(() => fetchText("https://start.example.com/feed", {}, fake, undefined, {}, resolve), /private/);
  const fromPrivate = await fetchText("https://start.example.com/feed", {}, fake, undefined, {}, async () => ["192.168.0.5"]);
  assert.equal(fromPrivate.status, 200);
});
