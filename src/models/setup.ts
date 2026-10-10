import { existsSync } from "node:fs";
import { join } from "node:path";
import { CogitatorProvider, keyFromFile } from "./cogitator.ts";
import type { KeySource } from "./cogitator.ts";
import { keyFromSecrets } from "../secrets/env.ts";
import type { SecretStore } from "../secrets/store.ts";
import { EgressGate } from "./egress.ts";
import { Embedder } from "./embedder.ts";
import { OpenAICompatibleProvider } from "./generic.ts";
import type { OpenAIEndpoint } from "./openai.ts";
import { EndpointPool } from "./pool.ts";
import type { ModelProvider } from "./provider.ts";

type Env = Record<string, string | undefined>;

/** The default for an endpoint's _LOCAL setting: an address that names this machine counts as local. */
export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

export function endpointFrom(env: Env, prefix: string, name: string, defaultModel: string): OpenAIEndpoint | null {
  const baseUrl = env[`${prefix}_URL`];
  if (!baseUrl) return null;
  const apiKey = env[`${prefix}_KEY`];
  const local = env[`${prefix}_LOCAL`];
  const extra = env[`${prefix}_EXTRA_BODY`];
  return { name, baseUrl, model: env[`${prefix}_MODEL`] ?? defaultModel, local: local ? local === "1" : isLoopback(baseUrl), ...(apiKey ? { apiKey } : {}), ...(extra ? { extraBody: JSON.parse(extra) as Record<string, unknown> } : {}) };
}

export function defaultDiscoveryFile(env: Env): string | undefined {
  const base = env["LOCALAPPDATA"];
  return base ? join(base, "Cogitator", "data", "discovery.json") : undefined;
}

/** True when Cogitator's discovery file is on this machine or its address is set. */
export function cogitatorPresent(env: Env): boolean {
  const discoveryFile = env["JUHANDU_COGITATOR_DISCOVERY"] ?? defaultDiscoveryFile(env);
  return Boolean(env["JUHANDU_COGITATOR_URL"]) || Boolean(discoveryFile && existsSync(discoveryFile));
}

/** The adapter buildProvider picks for this environment. */
export function chooseAdapter(env: Env): "cogitator" | "openai" | "off" {
  const choice = env["JUHANDU_LOCAL_AI"] ?? "auto";
  if (choice === "off") return "off";
  if (choice === "cogitator" || (choice === "auto" && cogitatorPresent(env))) return "cogitator";
  return env["JUHANDU_EMBED_URL"] || env["JUHANDU_CHAT_URL"] ? "openai" : "off";
}

/** Picks the local AI adapter. JUHANDU_LOCAL_AI=cogitator|openai|off; unset means Cogitator when it is installed here, else a plain OpenAI-style endpoint when one is configured, else off. */
export function buildProvider(env: Env, dataDir: string, secrets?: SecretStore): ModelProvider | null {
  const adapter = chooseAdapter(env);
  if (adapter === "off") return null;
  const discoveryFile = env["JUHANDU_COGITATOR_DISCOVERY"] ?? defaultDiscoveryFile(env);
  const gatewayUrl = env["JUHANDU_COGITATOR_URL"];
  if (adapter === "cogitator") {
    const folder = join(dataDir, "secrets");
    const store = secrets;
    // A key file named in the environment wins; otherwise the SecretStore (which also reads the older data/secrets key files), otherwise the files directly.
    const interactiveFile = env["JUHANDU_COGITATOR_KEY_FILE"];
    const backgroundFile = env["JUHANDU_COGITATOR_BACKGROUND_KEY_FILE"];
    const keyFor = (file: string | undefined, name: string, fallback: string): KeySource => (file ? keyFromFile(file) : store ? keyFromSecrets(store, name) : keyFromFile(join(folder, fallback)));
    return new CogitatorProvider({
      ...(discoveryFile ? { discoveryFile } : {}),
      ...(gatewayUrl ? { gatewayUrl } : {}),
      interactiveKey: keyFor(interactiveFile, "cogitator/interactive", "interactive.key"),
      backgroundKey: keyFor(backgroundFile, "cogitator/background", "background.key"),
    });
  }
  const embed = endpointFrom(env, "JUHANDU_EMBED", "embeddings", "nomic-embed-text-v1.5");
  const chat = endpointFrom(env, "JUHANDU_CHAT", "chat", "default");
  if (!embed && !chat) return null;
  const gate = new EgressGate(env["JUHANDU_PRIVATE_ALLOW"]?.split(",").map((s) => s.trim()).filter(Boolean));
  return new OpenAICompatibleProvider({
    ...(embed ? { embedPool: new EndpointPool([embed], gate) } : {}),
    ...(chat ? { chatPool: new EndpointPool([chat], gate) } : {}),
    embedTag: env["JUHANDU_EMBED_TAG"] ?? "nomic-embed-text-v1.5-q8_0",
  });
}

export function buildEmbedder(provider: ModelProvider | null, env: Env): Embedder | null {
  if (!provider?.capabilities.embed) return null;
  const dims = env["JUHANDU_EMBED_DIMS"] ? Number(env["JUHANDU_EMBED_DIMS"]) : undefined;
  return new Embedder({ provider, documentPrefix: env["JUHANDU_EMBED_DOC_PREFIX"] ?? "clustering: ", ...(dims ? { dims } : {}) });
}
