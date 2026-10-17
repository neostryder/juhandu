import type { SecretStore } from "./store.ts";
import type { KeySource } from "../models/cogitator.ts";

type Env = Record<string, string | undefined>;

/** Secret names for the keys Juhandu uses, and the environment variable each one fills when the variable is not already set. */
const KEY_SECRETS: { name: string; variable: string; unlessSet: string[] }[] = [
  { name: "jev/key", variable: "JUHANDU_JEV_KEY", unlessSet: ["JUHANDU_JEV_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY", "JUHANDU_JEV_KEY_FILE"] },
  { name: "jev/gateway_token", variable: "JUHANDU_JEV_GATEWAY_TOKEN", unlessSet: ["JUHANDU_JEV_GATEWAY_TOKEN", "JUHANDU_JEV_GATEWAY_TOKEN_FILE"] },
  { name: "chat/key", variable: "JUHANDU_CHAT_KEY", unlessSet: ["JUHANDU_CHAT_KEY"] },
  { name: "embed/key", variable: "JUHANDU_EMBED_KEY", unlessSet: ["JUHANDU_EMBED_KEY"] },
  { name: "transcribe/key", variable: "JUHANDU_TRANSCRIBE_KEY", unlessSet: ["JUHANDU_TRANSCRIBE_KEY"] },
  { name: "vision/key", variable: "JUHANDU_VISION_KEY", unlessSet: ["JUHANDU_VISION_KEY"] },
  { name: "youtube/key", variable: "JUHANDU_YOUTUBE_API_KEY", unlessSet: ["JUHANDU_YOUTUBE_API_KEY"] },
  { name: "trakt/client_id", variable: "JUHANDU_TRAKT_CLIENT_ID", unlessSet: ["JUHANDU_TRAKT_CLIENT_ID"] },
  { name: "tmdb/token", variable: "JUHANDU_TMDB_READ_TOKEN", unlessSet: ["JUHANDU_TMDB_READ_TOKEN"] },
];

/** A copy of the environment with the stored model keys filled in. A key set in the environment or a key file always wins, so old setups keep working. */
export async function envWithSecrets(env: Env, secrets: SecretStore): Promise<Env> {
  const out: Env = { ...env };
  for (const entry of KEY_SECRETS) {
    if (entry.unlessSet.some((name) => env[name])) continue;
    const value = await secrets.get(entry.name);
    if (value) out[entry.variable] = value;
  }
  return out;
}

/** A Cogitator key read from the SecretStore each time it is needed. */
export function keyFromSecrets(secrets: SecretStore, name: string): KeySource {
  return {
    get: async () => {
      const value = await secrets.get(name);
      if (!value) throw new Error(`No ${name} key is stored. Add it with: node src/secrets/cli.ts set ${name}`);
      return value;
    },
  };
}
