import type { ModelProvider } from "../models/provider.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { Store } from "../store/store.ts";
import { CaptionsRung } from "./captions.ts";
import { ProgramFinder } from "./exec.ts";
import { GeminiUrlRung } from "./gemini.ts";
import { AppSideRung, mediaEndpointsFrom } from "./local.ts";
import { VideoReader } from "./reader.ts";
import type { VideoRung } from "./types.ts";

type Env = Record<string, string | undefined>;

/** The ladder in order: Gemini by address, the video's captions, the app's own extraction. JUHANDU_VIDEO=off turns the reader off. A rung that is not set up stays on the ladder and says why, so the Connect screen can show what to add. */
export function buildVideoReader(env: Env, store: Store, provider: ModelProvider | null, secrets: SecretStore): VideoReader | null {
  if (env["JUHANDU_VIDEO"] === "off") return null;
  const finder = new ProgramFinder();
  const rungs: VideoRung[] = [
    new GeminiUrlRung({ secrets, env }),
    new CaptionsRung({ env, provider, finder }),
    new AppSideRung({ env, provider, endpoints: mediaEndpointsFrom(env), finder }),
  ];
  return new VideoReader(rungs, store);
}
