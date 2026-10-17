import { isPrivateHost } from "../util/network.ts";

export const USER_AGENT = "Juhandu/0.0 feed reader";
const MAX_BYTES = 10 * 1024 * 1024;

export interface ConditionalState {
  etag?: string | null;
  lastModified?: string | null;
}

export interface FetchResult {
  status: number;
  notModified: boolean;
  body: string;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
  contentType: string;
  /** Seconds the server asked us to wait before the next request, from Retry-After, when present. */
  retryAfter: number | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https URLs are allowed: ${raw}`);
  return url;
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new Error("Response is larger than the 10 MB limit");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/** One polite conditional GET. Sends If-None-Match and If-Modified-Since when known; a 304 returns notModified. */
export async function fetchText(url: string, state: ConditionalState = {}, fetchImpl: FetchLike = fetch, timeoutMs = 20_000, loginHeaders: Record<string, string> = {}): Promise<FetchResult> {
  assertHttpUrl(url);
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/atom+xml, application/rss+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.5, */*;q=0.1",
    "accept-encoding": "gzip, deflate",
  };
  if (state.etag) headers["if-none-match"] = state.etag;
  if (state.lastModified) headers["if-modified-since"] = state.lastModified;
  const signal = AbortSignal.timeout(timeoutMs);
  const hasLogin = Object.keys(loginHeaders).length > 0;
  // Redirects are followed by hand. Login headers go only to the origin they were given for, so a feed cannot bounce a cookie or password to another site, and a public address cannot redirect the fetch onto this machine or a private network.
  const origin = new URL(url).origin;
  const startedPrivate = isPrivateHost(new URL(url).hostname);
  let target = url;
  let response: Response;
  for (let hops = 0; ; hops++) {
    const sameOrigin = new URL(target).origin === origin;
    response = await fetchImpl(target, { headers: hasLogin && sameOrigin ? { ...headers, ...loginHeaders } : headers, redirect: "manual", signal });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && response.status !== 304 && location) {
      await response.body?.cancel();
      if (hops >= 5) throw new Error("Too many redirects");
      const next = assertHttpUrl(new URL(location, target).toString());
      if (!startedPrivate && isPrivateHost(next.hostname)) throw new Error("A public address redirected to a private one, so the fetch was stopped");
      target = next.toString();
      continue;
    }
    break;
  }
  const retry = Number(response.headers.get("retry-after"));
  const base = {
    status: response.status,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
    finalUrl: target,
    contentType: response.headers.get("content-type") ?? "",
    retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null,
  };
  if (response.status === 304) return { ...base, notModified: true, body: "" };
  if (!response.ok) return { ...base, notModified: false, body: "" };
  return { ...base, notModified: false, body: await readCapped(response) };
}
