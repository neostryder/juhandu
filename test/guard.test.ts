import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { RequestGuard } from "../src/api/guard.ts";
import { createApp } from "../src/api/server.ts";
import { Ingestor } from "../src/ingest/ingest.ts";
import { Store } from "../src/store/store.ts";

test("the guard answers this machine's own names and refuses any other host", () => {
  const guard = new RequestGuard();
  for (const host of ["127.0.0.1:8787", "localhost", "LOCALHOST:3000", "[::1]:8787"]) assert.equal(guard.refusal({ host }), null, host);
  for (const host of ["evil.example", "evil.example:8787", "127.0.0.1.evil.example", "", undefined]) assert.notEqual(guard.refusal({ host }), null, String(host));
});

test("the guard refuses an origin that is not this machine or a listed public host", () => {
  const guard = new RequestGuard(["reader.example.com"]);
  assert.equal(guard.refusal({ host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" }), null);
  assert.equal(guard.refusal({ host: "127.0.0.1:8787", origin: "http://[::1]:8787" }), null);
  assert.equal(guard.refusal({ host: "reader.example.com", origin: "https://reader.example.com" }), null);
  assert.notEqual(guard.refusal({ host: "127.0.0.1:8787", origin: "https://evil.example" }), null);
  assert.notEqual(guard.refusal({ host: "reader.example.com", origin: "https://evil.example" }), null);
  assert.notEqual(guard.refusal({ host: "127.0.0.1:8787", origin: "null" }), null);
  assert.notEqual(guard.refusal({ host: "127.0.0.1:8787", origin: "http://localhost:3000" }), null, "another local port is another origin");
  assert.notEqual(guard.refusal({ host: "127.0.0.1:8787", origin: "http://localhost" }), null, "the default port is not this port");
  assert.equal(guard.refusal({ host: "reader.example.com:443", origin: "https://reader.example.com" }), null, "a default port named in Host matches an Origin without one");
  assert.notEqual(guard.refusal({ host: "reader.example.com:443", origin: "http://reader.example.com" }), null, "port 80 is not port 443");
  assert.notEqual(guard.refusal({ host: "reader.example.com", origin: "https://reader.example.com:8443" }), null, "an Origin on an odd port does not match a Host with none");
  assert.notEqual(guard.refusal({ host: "other.example.com" }), null);
});

function send(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the API refuses a wrong host or origin and a body that is not JSON, and accepts the same request done right", async () => {
  const store = new Store(":memory:");
  const server = createApp({ store, ingestor: new Ingestor(store), publicHosts: ["reader.example.com"], webRoot: ".", version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const json = { "content-type": "application/json" };
  try {
    assert.equal(await send(port, "GET", "/api/items", {}), 200);
    assert.equal(await send(port, "GET", "/api/items", { host: "evil.example" }), 403, "a rebinding host is refused");
    assert.equal(await send(port, "GET", "/api/items", { host: "reader.example.com" }), 200, "a listed public host is answered");
    assert.equal(await send(port, "GET", "/api/items", { origin: "https://evil.example" }), 403, "a page on another site is refused");
    assert.equal(await send(port, "POST", "/api/items/read-all", { origin: "https://evil.example" }), 403, "a cross-site write is refused");
    assert.equal(await send(port, "POST", "/api/items/read-all", { origin: `http://127.0.0.1:${port}` }), 200, "the app's own page may write");
    assert.equal(await send(port, "POST", "/api/sources", { "content-type": "text/plain" }, "{}"), 415, "a body that is not JSON is refused");
    assert.equal(await send(port, "POST", "/api/sources", { "content-type": "application/x-www-form-urlencoded" }, "url=x"), 415, "a form post is refused");
    assert.equal(await send(port, "POST", "/api/items/read-all", { "content-type": "text/plain" }, "x"), 415, "even a route that reads no body refuses one that is not JSON");
    assert.equal(await send(port, "POST", "/api/sources", json, JSON.stringify({ url: "file:///etc/passwd" })), 422);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
