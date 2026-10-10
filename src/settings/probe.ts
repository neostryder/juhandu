// The Test buttons on the Connect screen. Each one makes the smallest real request that proves an address, a model and a key work
// together, and turns a failure into plain words. A server's reply body is never passed back, only what its status means.
import { crc32, deflateSync } from "node:zlib";
import type { OpenAIEndpoint } from "../models/openai.ts";
import { authHeaders, joinUrl } from "../models/openai.ts";
import type { FetchLike } from "../sources/fetcher.ts";

export interface ProbeResult {
  ok: boolean;
  message: string;
}

const TIMEOUT_SECONDS = 30;
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Plain words for a request that never got an answer. */
export function networkFailure(error: unknown, host: string): string {
  const err = error as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const code = err.cause?.code ?? err.code ?? "";
  if (err.name === "TimeoutError" || err.name === "AbortError" || err.cause?.name === "TimeoutError") return `${host} did not answer within ${TIMEOUT_SECONDS} seconds.`;
  if (code === "ECONNREFUSED") return `Nothing answered at ${host}. Check that the server is running and that the address and port are right.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `The host name in ${host} could not be found. Check the spelling.`;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") return `${host} closed the connection. Check whether the address should start with https:// or http://.`;
  if (/CERT|SELF_SIGNED|TLS|SSL/i.test(code)) return `The HTTPS certificate of ${host} was not accepted.`;
  return `Could not reach ${host}.`;
}

async function errorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown; type?: unknown } };
    return `${String(body.error?.code ?? "")} ${String(body.error?.type ?? "")}`.toLowerCase();
  } catch {
    return "";
  }
}

/** Plain words for an answer that was not a success. */
async function statusFailure(response: Response, endpoint: OpenAIEndpoint, path: string): Promise<string> {
  const status = response.status;
  if (status === 401 || status === 403) return endpoint.apiKey ? "The server refused the key. Check that it is the right one." : "The server wants a key. Paste one in the key field and save.";
  if (status === 404) {
    if ((await errorCode(response)).includes("model")) return `The server has no model called ${endpoint.model}. Check the model name.`;
    return `The server has nothing at ${path}. The address usually ends in /v1.`;
  }
  if (status === 429 || status === 503) return "The server is busy or over its limit. Try again in a minute.";
  if (status >= 500) return `The server ran into an error (status ${status}). Its own log says more.`;
  return `The server turned down the test request (status ${status}). Check the model name.`;
}

async function post(endpoint: OpenAIEndpoint, path: string, init: { headers: Record<string, string>; body: BodyInit }, fetchImpl: FetchLike): Promise<Response | string> {
  try {
    return await fetchImpl(joinUrl(endpoint.baseUrl, path), { method: "POST", headers: init.headers, body: init.body, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000) });
  } catch (error) {
    return networkFailure(error, hostOf(endpoint.baseUrl));
  }
}

/** A short silent WAV file: half a second of 16 kHz mono audio. */
export function silentWav(): Buffer {
  const samples = 8_000;
  const data = samples * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(32_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(data, 40);
  return out;
}

/** A small grey square as a PNG, big enough for vision models that refuse tiny images. */
export function greySquarePng(size = 64): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), body])));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(0, 9);
  const rows = Buffer.alloc((size + 1) * size, 128);
  for (let y = 0; y < size; y++) rows[y * (size + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

export async function probeChat(endpoint: OpenAIEndpoint, fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  const body = { model: endpoint.model, messages: [{ role: "user", content: "Reply with the word ok." }], max_tokens: 8, temperature: 0, stream: false, ...endpoint.extraBody };
  const response = await post(endpoint, "/chat/completions", { headers: authHeaders(endpoint.apiKey), body: JSON.stringify(body) }, fetchImpl);
  if (typeof response === "string") return { ok: false, message: response };
  if (!response.ok) return { ok: false, message: await statusFailure(response, endpoint, "/chat/completions") };
  const parsed = (await response.json().catch(() => null)) as { choices?: unknown[] } | null;
  if (!Array.isArray(parsed?.choices)) return { ok: false, message: "The server answered, but not in the form a chat model answers in. Check the address." };
  return { ok: true, message: `The chat model ${endpoint.model} answered.` };
}

export async function probeEmbed(endpoint: OpenAIEndpoint, fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  const response = await post(endpoint, "/embeddings", { headers: authHeaders(endpoint.apiKey), body: JSON.stringify({ model: endpoint.model, input: ["A test sentence."] }) }, fetchImpl);
  if (typeof response === "string") return { ok: false, message: response };
  if (!response.ok) return { ok: false, message: await statusFailure(response, endpoint, "/embeddings") };
  const parsed = (await response.json().catch(() => null)) as { data?: { embedding?: unknown[] }[] } | null;
  const size = parsed?.data?.[0]?.embedding?.length ?? 0;
  if (!size) return { ok: false, message: "The server answered, but sent back no embedding. Check that the model makes embeddings." };
  return { ok: true, message: `The embedding model ${endpoint.model} answered with ${size} numbers per text.` };
}

export async function probeTranscribe(endpoint: OpenAIEndpoint, fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(silentWav())],{ type: "audio/wav" }), "test.wav");
  form.set("model", endpoint.model);
  const headers = authHeaders(endpoint.apiKey);
  delete headers["content-type"];
  const response = await post(endpoint, "/audio/transcriptions", { headers, body: form }, fetchImpl);
  if (typeof response === "string") return { ok: false, message: response };
  if (!response.ok) return { ok: false, message: await statusFailure(response, endpoint, "/audio/transcriptions") };
  return { ok: true, message: `The speech server answered with ${endpoint.model}.` };
}

export async function probeVision(endpoint: OpenAIEndpoint, fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  const image = `data:image/png;base64,${greySquarePng().toString("base64")}`;
  const body = { model: endpoint.model, max_tokens: 8, temperature: 0, messages: [{ role: "user", content: [{ type: "text", text: "Name the color of this square in one word." }, { type: "image_url", image_url: { url: image } }] }] };
  const response = await post(endpoint, "/chat/completions", { headers: authHeaders(endpoint.apiKey), body: JSON.stringify(body) }, fetchImpl);
  if (typeof response === "string") return { ok: false, message: response };
  if (!response.ok) return { ok: false, message: await statusFailure(response, endpoint, "/chat/completions") };
  return { ok: true, message: `The vision server answered with ${endpoint.model}.` };
}

/** Asks Google for one model name with the key: free, and enough to prove the key is accepted. */
export async function probeGemini(key: string, fetchImpl: FetchLike = fetch): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${GEMINI_API}/models?pageSize=1`, { headers: { "x-goog-api-key": key }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000) });
  } catch (error) {
    return { ok: false, message: `Juhandu could not reach Google. ${networkFailure(error, "generativelanguage.googleapis.com")}` };
  }
  if (response.ok) return { ok: true, message: "Google accepted the key." };
  let reasons = "";
  try {
    const body = (await response.json()) as { error?: { status?: string; details?: { reason?: string }[] } };
    reasons = [body.error?.status ?? "", ...(body.error?.details ?? []).map((d) => d.reason ?? "")].join(" ");
  } catch {
    // The status code alone still says enough.
  }
  if (/API_KEY_INVALID/.test(reasons) || response.status === 400) return { ok: false, message: "Google says this key is not valid. Copy it again from Google AI Studio and save it." };
  if (response.status === 401 || response.status === 403) return { ok: false, message: "Google refused the key. In Google AI Studio or Google Cloud, check that the key may use the Gemini API." };
  if (response.status === 429) return { ok: false, message: "Google says this key is over its limit right now. Try again later." };
  return { ok: false, message: `Google could not check the key right now (status ${response.status}). Try again later.` };
}
