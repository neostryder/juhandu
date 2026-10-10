# Dependencies

Juhandu has no runtime npm dependencies. The server uses only Node's own modules, including `node:sqlite` for storage, `node:http` for the web server, `node:tls` for the mail client and the built-in `fetch` for everything else on the network, and the browser code uses only what the browser provides. Running Juhandu therefore installs no third-party code from npm, and there is no runtime package tree to audit, patch or keep up to date. `npm start` works on a fresh clone without `npm install`.

## Node

Juhandu needs Node 26 or newer, as set by `engines` in `package.json`. Node runs the TypeScript source directly by stripping the types, so there is no compiler or bundler in the path from source to running server.

## Docker

Docker is an optional way to run Juhandu. The `Dockerfile` builds from the `node:26-alpine` image, copies in the source, and installs no npm packages. Built with `--build-arg VIDEO_TOOLS=true`, the image also gets Alpine's `yt-dlp` and `ffmpeg` packages, the programs listed under Optional programs below; otherwise neither is in it. The image has no credential store programs and no `bws`, so those secret backends show as not available there.

## Development dependencies

These are installed by `npm install` and used only for type checking. Versions are the ones pinned in `package-lock.json`, and licenses are taken from each package's own `package.json`.

| Package | Version | License | Why |
| --- | --- | --- | --- |
| `typescript` | 7.0.2 | Apache-2.0 | Provides `tsc`, which `npm run typecheck` runs over the server code, the browser code and the tests. |
| `@types/node` | 26.6.4 | MIT | Type definitions for Node's built-in modules. |
| `undici-types` | 8.9.0 | MIT | Type definitions for `fetch` and related classes, required by `@types/node`. |
| `@typescript/typescript-<platform>` | 7.0.2 | Apache-2.0 | The native compiler binary for the current platform. `typescript` lists one package per platform as optional, and npm installs only the one that matches. |

## Optional programs

The video reader and the secret store call outside programs when they are present. A missing program switches off only the part that needs it: a way of reading videos that cannot run says why on the Connect screen, and a secret backend that cannot run shows as not available in `node src/secrets/cli.ts status`.

| Program | License | Used for |
| --- | --- | --- |
| yt-dlp | Unlicense | Fetching a video's captions, and its audio and frames for the app's own reading. Set its path with `JUHANDU_YTDLP`. |
| ffmpeg | LGPL or GPL, depending on how your copy was built; check your build | Converting the audio for the speech server and cutting still frames for the vision server. Set its path with `JUHANDU_FFMPEG`. |
| `bws` (Bitwarden Secrets Manager command line) | check your copy | Reading secrets when `BWS_ACCESS_TOKEN` is set. |
| `pwsh` or `powershell` on Windows, `security` on macOS, `secret-tool` on Linux | part of the operating system or its packages | Reading and writing secrets in the operating system's credential store. |

## Web fonts

The web page loads two fonts from Google Fonts: Cormorant Garamond for headings and Alegreya Sans for body text. Both are released under the SIL Open Font License. The browser fetches them from fonts.googleapis.com and fonts.gstatic.com, and the page falls back to Georgia and the system font when they cannot be loaded. The app works without them, and the offline copy leaves them to the browser's own cache.

## Services

Juhandu contacts only the sites you subscribe to and the services you configure. Each service below is optional except the feeds themselves.

| Service | When | What is sent |
| --- | --- | --- |
| Feed sites | Every poll, every 30 minutes per feed by default | A request for the feed, with the last ETag and Last-Modified values, and the feed's login when it has one. A login is sent only to the site it was given for. |
| YouTube | When you add a channel, handle or playlist, when its feed is polled, and when yt-dlp reads a video | Requests for the page, the video feed, and the video's captions or audio. |
| Cogitator, an optional local model host that is not publicly available yet | When its discovery file is found or `JUHANDU_COGITATOR_URL` is set; nothing needs it, and any OpenAI-style endpoint below does the same work | Item text for embeddings, summaries, story merging, pipe questions and rule proposals. It is treated as being on this machine, so it may receive private items. |
| OpenAI-style embedding and chat endpoints | When `JUHANDU_EMBED_URL` or `JUHANDU_CHAT_URL` is set | The same item text as above. A hosted endpoint receives only public items unless it is named in `JUHANDU_PRIVATE_ALLOW`. |
| Speech-to-text endpoint | When `JUHANDU_TRANSCRIBE_URL` is set | A video's audio, up to 24 MB. |
| Vision endpoint | When `JUHANDU_VISION_URL` is set | Still frames from a video, 12 by default. |
| Gemini, at generativelanguage.googleapis.com | When a Google API key is set and `JUHANDU_GEMINI` is not `off` | The address of a public YouTube video and a request to describe it. Private videos are never sent. |
| Typed-decision servers you run yourself | When `JUHANDU_TYPED_URLS` is set and `typed` is in `JUHANDU_JUDGE` or `JUHANDU_JUDGE_SHADOW` | Judge questions with the item text they concern. These servers are treated as being on this machine, so they may receive private items. |
| Jev judge service, at api.typesafe.ai by default | When a Jev key is set and `jev` is in `JUHANDU_JUDGE` or `JUHANDU_JUDGE_SHADOW` | Judge questions with the item text they concern, public items only unless `jev` is named in `JUHANDU_PRIVATE_ALLOW`. |
| Your SMTP server | When email delivery is on | The daily briefing, with private items left out unless you include them. |
| Telegram, at api.telegram.org | When Telegram delivery is on | The daily briefing, never with private items. |
| Discord, at your webhook's address, or at discord.com for a direct message | When Discord delivery is on | The daily briefing, never with private items. A direct message also sends the bot token and your Discord user id. |
| Bitwarden Secrets Manager, through `bws` | When `BWS_ACCESS_TOKEN` is set | Lookups of secrets by name. |
