# Setting up Juhandu

Every setting is optional. A fresh clone runs with `npm start` and no settings at all: it listens on http://127.0.0.1:8787, keeps its data in the project's `data` folder, and leaves the AI features off until you connect a model. Models and video reading can be set up on the Connect screen while Juhandu runs, and every setting can also come from an environment variable.

## Connecting models

### On the Connect screen

The Models section of the Connect screen sets up the chat and embedding endpoints or Cogitator, and its Reading videos section sets up the Gemini key, the speech and vision servers, and which ways of reading are on. Each one has a Test button that sends one small request and says in plain words what went wrong. A saved change takes effect at once, with no restart.

Keys go to the secret store, never to the database, and the screen only says whether a key is saved. Other values are kept in the database. An environment variable always wins over a value saved on the screen: a setting that comes from the environment is marked as set by the server and cannot be changed there, and each field names its variable underneath. Saving an address on this machine or on a private network asks you to confirm that the server there is yours.

### With environment variables

Juhandu picks a model adapter with `JUHANDU_LOCAL_AI`, which the Connect screen calls Where models come from. Left at `auto`, it uses Cogitator when Cogitator is set up (see below), and otherwise uses the OpenAI-style endpoints named by `JUHANDU_EMBED_URL` and `JUHANDU_CHAT_URL`. With neither, AI features stay off and the rest of Juhandu works. The start-up log says which adapter it chose.

### OpenAI-style endpoints

Any server that answers the OpenAI `/embeddings` and `/chat/completions` routes works, whether it runs on this machine or is a hosted API. The address is the base URL that those routes hang off, usually ending in `/v1`. For a model server on this machine:

```
JUHANDU_EMBED_URL=http://127.0.0.1:8080/v1
JUHANDU_EMBED_MODEL=nomic-embed-text-v1.5
JUHANDU_CHAT_URL=http://127.0.0.1:8080/v1
JUHANDU_CHAT_MODEL=your-chat-model
```

The embedding endpoint is used for taste, semantic rules, story matching and rule proposals. The chat endpoint writes summaries, story lines and rule drafts, answers pipe questions, digests video captions and, by default, acts as the judge. Either one can be set alone, and the features that need the other stay off.

Each endpoint takes the same set of variables after its prefix: `_URL` turns it on, `_KEY` is the API key sent as a bearer token, `_MODEL` names the model, `_LOCAL` set to `1` or `0` overrides whether it counts as on this machine (by default a loopback address counts as local), and, for the chat endpoint, `_EXTRA_BODY` is JSON added to each request. `JUHANDU_EMBED_KEY` and `JUHANDU_CHAT_KEY` can also come from the secret store under `embed/key` and `chat/key`.

| Prefix | Used for | Default model |
| --- | --- | --- |
| `JUHANDU_EMBED` | Embeddings | `nomic-embed-text-v1.5` |
| `JUHANDU_CHAT` | Summaries, proposals, the judge, caption digests | `default` |
| `JUHANDU_TRANSCRIBE` | Speech to text for videos (`/audio/transcriptions`) | `whisper-1` |
| `JUHANDU_VISION` | Describing video frames (`/chat/completions` with images) | `default` |

Embeddings are stored with a name, `JUHANDU_EMBED_TAG`, and embeddings with different names are never compared. Change the tag when you change the embedding model, so old and new vectors are not mixed.

### Cogitator

Cogitator is a local model host that Juhandu can use in place of separate endpoints. It is optional, it is not publicly available yet, and nothing in Juhandu needs it: any OpenAI-style embedding and chat endpoint does the same work.

Juhandu finds Cogitator through a discovery file, a JSON document with `schema` set to `1`, an `openai_base` URL, a `health` URL, and a list of `roles`, each with a `name` and a `chain` of model names. Juhandu uses the roles named `embed-gemma2`, `summarize`, and `judge`, and falls back to `embed` for embeddings and to `describe` for summaries and judging. It reads the file from `JUHANDU_COGITATOR_DISCOVERY`, by default `%LOCALAPPDATA%\Cogitator\data\discovery.json` on Windows, or fetches it from `/v1/cogitator/discovery` under `JUHANDU_COGITATOR_URL`. Requests carry one of two bearer keys: the interactive key for work you are waiting on and the background key for the rest. They come from the secrets `cogitator/interactive` and `cogitator/background`, or from the files named by `JUHANDU_COGITATOR_KEY_FILE` and `JUHANDU_COGITATOR_BACKGROUND_KEY_FILE`.

Cogitator is always treated as being on this machine, so it may receive private items.

### Judges

A judge answers the yes or no, pick-one and rank questions: whether two items are the same story, and the questions your pipes ask. `JUHANDU_JUDGE` lists the judges whose answers count, in the order they are tried, and `JUHANDU_JUDGE_SHADOW` lists judges that are asked the same questions only so their answers can be logged and compared. Every answer goes into the decision log either way. There are three kinds:

- `llm` asks the chat model. It is the default when a chat model is configured.
- `typed` asks your own servers that speak the typed-decision protocol, `POST /v1/systemone`. List their base URLs in `JUHANDU_TYPED_URLS`, separated by commas; Juhandu uses the first one that answers and skips a failing one for a while. `JUHANDU_TYPED_MODEL` is the model name sent with each request. To send a different model for each kind of decision, set `JUHANDU_TYPED_LANE_MODEL` to a template such as `adapter-{lane}`, where `{lane}` becomes `same_story` or `pipe_ask`; the template is ignored when `JUHANDU_TYPED_MODEL` is set. A typed server is not assumed to be calibrated, so it only shadows, even when it is listed in `JUHANDU_JUDGE`, until you set `JUHANDU_TYPED_ACTS=1`. Typed servers are sent no key and are always treated as being on this machine, so they may receive private items.
- `jev` asks the hosted Jev service from TypeSafe over the same protocol. It needs a key from `JUHANDU_JEV_KEY`, `TYPESAFE_API_KEY`, `JEV_API_KEY`, the file named by `JUHANDU_JEV_KEY_FILE`, or the secret `jev/key`. Jev is a hosted endpoint, so it gets private items only when `jev` is named in `JUHANDU_PRIVATE_ALLOW`.

Each question is asked twice in one request, the second time phrased the other way round, and the two answers are averaged. For example, `JUHANDU_JUDGE=jev,llm` and `JUHANDU_JUDGE_SHADOW=typed` lets Jev answer, falls back to the chat model when Jev cannot, and logs a typed server's answers beside them.

### Private items

Every feed is public or private. Public items may go to any endpoint. Private items go only to endpoints on this machine and to endpoints named in `JUHANDU_PRIVATE_ALLOW`, a comma-separated list of `embeddings`, `chat`, `transcription`, `vision` and `jev`. When no allowed endpoint is available, the work on a private item waits in the queue.

## Running behind a reverse proxy

Juhandu has no sign-in yet, so anything beyond this machine should reach it only through a reverse proxy that authenticates every request, such as Cloudflare Access. Keep `JUHANDU_HOST` at `127.0.0.1` when the proxy runs on the same machine, and set `JUHANDU_PUBLIC_HOST` to the public name the proxy serves, such as `JUHANDU_PUBLIC_HOST=news.example.com`. The API answers only requests addressed to this machine or to a name in that list, so without it the page loads but every API call from it is refused with a 403. A proxy that rewrites the `Host` header to the local address still needs the public name listed, because the browser's `Origin` header carries it.

Programs that call the API directly follow the same rule, and a request with a body must send it with `Content-Type: application/json`, or it is refused with a 415.

The MCP endpoint at `/mcp` is stricter about proxies. Without an access token, it answers only a request addressed to `localhost`, `127.0.0.1` or `[::1]` that carries no proxy header such as `Forwarded`, `X-Forwarded-For`, `X-Real-IP` or `Cf-Connecting-Ip`. A request through a proxy, or one addressed to a name in `JUHANDU_PUBLIC_HOST`, needs the token, which the Connect screen creates.

A proxy or CDN in front of Juhandu may cache its files, and an upgrade still reaches the browser on the first load. The page is sent with `Cache-Control: no-cache`, so it is checked with the server every time, and every script and stylesheet address in it ends in `?v=` and a fingerprint of the app's files. A new release changes the fingerprint, so the browser asks for new addresses and nothing old is served from any cache. Files fetched under the current fingerprint may be kept for a year. A cache in front of Juhandu has to include the query string in its cache key, which Cloudflare's default Standard caching level does.

## Running in Docker

The repository has a `Dockerfile` and a `compose.yaml`. From the project folder, this builds the image and starts Juhandu in the background on http://127.0.0.1:8787:

```
docker compose up -d --build
```

The image is built from `node:26-alpine`, holds only `package.json`, `src` and `web`, installs no npm packages, and runs `node src/main.ts` as the unprivileged `node` user. A health check calls `/api/health` every 30 seconds, and `docker compose ps` shows the service as `healthy` once it answers. To follow the log:

```
docker compose logs -f
```

The database and the secrets folder live in a Docker volume mounted at `/data` (`JUHANDU_DATA=/data`), so they survive restarts and rebuilds. The operating system's credential store and Bitwarden Secrets Manager are not available in the container, so secrets come from environment variables or from the `dir` backend at `/data/secrets`, whose files only the owner can read. `node src/secrets/cli.ts set` writes new secrets to that folder. On Windows, pipe the value in with `type key.txt |` in place of the `<` redirection:

```
docker compose exec -T juhandu node src/secrets/cli.ts set chat/key < key.txt
```

Settings go in a `.env` file next to `compose.yaml`, one `NAME=value` per line, and compose reads it when it exists. Secrets can go there too, as `JUHANDU_SECRET_<NAME>` variables or as keys such as `JUHANDU_CHAT_KEY`. Run `docker compose up -d` after changing the file so the container starts again with the new values. Leave `JUHANDU_HOST`, `JUHANDU_PORT` and `JUHANDU_DATA` to the image. To use a different port on the host, set `JUHANDU_HOST_PORT`, and the container keeps listening on 8787.

Inside the container the server listens on `0.0.0.0`, so the start-up warning about listening beyond this machine always prints there. The warning describes the address inside the container. `compose.yaml` publishes the port on the host's 127.0.0.1 only, so nothing else on the network reaches it.

From inside the container, `127.0.0.1` is the container itself, so a model server running on the Docker host is reached at `host.docker.internal`, for example `JUHANDU_CHAT_URL=http://host.docker.internal:8080/v1`. Docker Desktop provides that name. On Linux, add `extra_hosts: ["host.docker.internal:host-gateway"]` to the `juhandu` service in `compose.yaml`. Since `host.docker.internal` is not a loopback address, Juhandu treats that endpoint as off this machine and sends it no private items. To let private items through, set the endpoint's `_LOCAL` variable to `1`, such as `JUHANDU_CHAT_LOCAL=1`, or name the endpoint in `JUHANDU_PRIVATE_ALLOW`, such as `JUHANDU_PRIVATE_ALLOW=embeddings,chat`.

The image includes yt-dlp, which is enough to read a video's own captions. Reading a video that has no captions also needs ffmpeg, which adds about 125 MB to the image, so it is left out unless the image is built with `VIDEO_TOOLS=full`. The build argument takes `captions`, the default, which adds yt-dlp alone at about 22 MB; `full`, which adds both; and `none`, which leaves only Gemini. To build with ffmpeg, put `VIDEO_TOOLS=full` in `.env` and run `docker compose up -d --build`, or build once with this command and then run `docker compose up -d`:

```
docker compose build --build-arg VIDEO_TOOLS=full
```

yt-dlp has to keep up with changes on YouTube, so rebuild the image with `docker compose build --no-cache` now and then to update it. The Reading videos section of the Connect screen says when yt-dlp or ffmpeg is missing and how to add it.

To reach Juhandu from other machines, put a reverse proxy that authenticates every request in front of it, as described above, and set `JUHANDU_PUBLIC_HOST` in `.env` to the proxy's public name. Compose passes it to the container. A proxy on the same host forwards to `127.0.0.1:8787`. Change the `ports` line in `compose.yaml` to publish beyond 127.0.0.1 only for a proxy that cannot reach that address, such as one on another machine.

To upgrade, pull the new code and rebuild. The data volume is kept.

```
git pull
```

```
docker compose up -d --build
```

`docker compose down` stops and removes the container and keeps the data volume. To delete the database and the secrets folder as well:

```
docker compose down -v
```

## Settings

Server and briefing:

| Variable | Default | What it changes |
| --- | --- | --- |
| `JUHANDU_HOST` | `127.0.0.1` | The address the server listens on. Anything other than `127.0.0.1`, `::1` or `localhost` prints a warning, because Juhandu has no sign-in yet. |
| `JUHANDU_PORT` | `8787` | The port. `PORT` is read when this is unset. |
| `JUHANDU_DATA` | `data` in the project | The folder for the database and the `secrets` folder. |
| `JUHANDU_BRIEFING_HOUR` | `7` | The hour, in server local time, after which the daily briefing is built. |
| `JUHANDU_MERGE_SIMILARITY` | `0.82` | How similar two items must be before the judge is asked whether they are the same story. |
| `JUHANDU_PUBLIC_HOST` | none | Comma-separated host names, besides this machine's own, that the web app and the API answer to. Set it to the public name when Juhandu runs behind a reverse proxy; without it, every API request through that name is refused. |
| `JUHANDU_PRIVATE_ALLOW` | none | Comma-separated endpoint names that may receive private items. |

Model adapter and embeddings:

| Variable | Default | What it changes |
| --- | --- | --- |
| `JUHANDU_LOCAL_AI` | `auto` | `cogitator`, `openai` or `off`. |
| `JUHANDU_EMBED_URL`, `_KEY`, `_MODEL`, `_LOCAL` | none | The embedding endpoint, as described above. |
| `JUHANDU_CHAT_URL`, `_KEY`, `_MODEL`, `_LOCAL`, `_EXTRA_BODY` | none | The chat endpoint. |
| `JUHANDU_EMBED_TAG` | `nomic-embed-text-v1.5-q8_0` | The name stored with each embedding. |
| `JUHANDU_EMBED_DIMS` | the model's own | Keeps only this many dimensions of each embedding. |
| `JUHANDU_EMBED_DOC_PREFIX` | the model's own | Text put in front of each item before it is embedded. |
| `JUHANDU_EMBED_QUERY_PREFIX` | the model's own | Text put in front of each rule sentence and example before it is embedded. |
| `JUHANDU_COGITATOR_EMBED_ROLE` | `embed-gemma2` | The Cogitator role that embeds text. |
| `JUHANDU_COGITATOR_URL` | none | Cogitator's address, when its discovery file is not on this machine. |
| `JUHANDU_COGITATOR_DISCOVERY` | `%LOCALAPPDATA%\Cogitator\data\discovery.json` on Windows, none elsewhere | Where to find Cogitator's discovery file. |
| `JUHANDU_COGITATOR_KEY_FILE` | none | A file holding Cogitator's interactive key, in place of the secret `cogitator/interactive`. |
| `JUHANDU_COGITATOR_BACKGROUND_KEY_FILE` | none | A file holding Cogitator's background key, in place of the secret `cogitator/background`. |

Judges:

| Variable | Default | What it changes |
| --- | --- | --- |
| `JUHANDU_JUDGE` | `llm` when a chat model exists | Comma-separated judges whose answers count, in the order they are tried: `llm`, `typed`, `jev`. |
| `JUHANDU_JUDGE_SHADOW` | none | Judges asked only so their answers are logged. |
| `JUHANDU_TYPED_URLS` | none | Comma-separated base URLs of typed-decision servers. |
| `JUHANDU_TYPED_MODEL` | `default` | The model name sent to the typed-decision servers. |
| `JUHANDU_TYPED_LANE_MODEL` | none | A template such as `adapter-{lane}` that names a model for each kind of decision. Ignored when `JUHANDU_TYPED_MODEL` is set. |
| `JUHANDU_TYPED_ACTS` | off | Set to `1` to let a typed server's answers count; otherwise it only shadows. |
| `JUHANDU_JEV_URL` | `https://api.typesafe.ai` | The Jev service. |
| `JUHANDU_JEV_MODEL` | `jev-preview` | The Jev model. |
| `JUHANDU_JEV_KEY` | none | The Jev key. `TYPESAFE_API_KEY` and `JEV_API_KEY` are read too. |
| `JUHANDU_JEV_KEY_FILE` | none | A file holding the Jev key. |

Videos:

| Variable | Default | What it changes |
| --- | --- | --- |
| `JUHANDU_VIDEO` | on | Set to `off` to switch the video reader off. |
| `JUHANDU_VIDEO_BATCH` | `3` | Videos read in each run of the video reader, which runs once a minute. |
| `JUHANDU_GEMINI` | on | Set to `off` to skip Gemini. |
| `JUHANDU_GEMINI_KEY` | none | The Google API key. The secret `gemini_api_key` (or `gemini/key`) works too. |
| `JUHANDU_GEMINI_MODELS` | the newest Flash models the key can use | Comma-separated Gemini models to try instead. |
| `JUHANDU_TRANSCRIBE_URL`, `_KEY`, `_MODEL`, `_LOCAL` | none | The speech-to-text endpoint. |
| `JUHANDU_VISION_URL`, `_KEY`, `_MODEL`, `_LOCAL` | none | The vision endpoint. |
| `JUHANDU_YTDLP` | `yt-dlp` on the path | Where yt-dlp is. |
| `JUHANDU_FFMPEG` | `ffmpeg` on the path | Where ffmpeg is. |
| `JUHANDU_VIDEO_LANGS` | `en.*,en` | Caption languages to fetch. |
| `JUHANDU_VIDEO_FRAMES` | `12` | Frames sent to the vision server, up to 40. |

Secrets and the MCP bridge:

| Variable | Default | What it changes |
| --- | --- | --- |
| `JUHANDU_SECRETS` | `env,bws,os,dir` | Which secret backends to use, in order. |
| `JUHANDU_SECRETS_DIR` | `secrets` in the data folder | The folder for the `dir` backend. |
| `JUHANDU_SECRET_<NAME>` | none | Hands one secret in through the environment (see below). |
| `BWS_ACCESS_TOKEN` | none | Turns on the Bitwarden Secrets Manager backend. |
| `JUHANDU_BWS_PROJECT` | none | The Bitwarden Secrets Manager project to look in. |
| `JUHANDU_URL` | `http://127.0.0.1:8787` | Where `src/mcp/stdio.ts` finds Juhandu. |
| `JUHANDU_MCP_TOKEN` | none | The token `src/mcp/stdio.ts` sends. |

## Secrets

API keys, feed logins, notification passwords and the MCP token live in a secret store, never in the database, the API's responses or the log. The store reads from these backends in order:

- `env`: environment variables named `JUHANDU_SECRET_<NAME>`.
- `bws`: Bitwarden Secrets Manager through the `bws` command, when `BWS_ACCESS_TOKEN` is set. A secret is found by its own name, by `JUHANDU_<NAME>` or by `<NAME>`, so `gemini_api_key` also finds `GEMINI_API_KEY`.
- `os`: the operating system's credential store (Windows Credential Manager, the macOS Keychain or libsecret).
- `dir`: a folder of files readable only by the owner.

New secrets are written to the credential store, or to the folder when there is no credential store. The `env` and `bws` backends are read only.

To hand a secret in as an environment variable, take its name, uppercase it, turn every character other than a letter or digit into `_`, and put `JUHANDU_SECRET_` in front. The secret `notify.telegram.token` becomes `JUHANDU_SECRET_NOTIFY_TELEGRAM_TOKEN`. The names in use are `cogitator/interactive`, `cogitator/background`, `embed/key`, `chat/key`, `transcribe/key`, `vision/key`, `jev/key`, `gemini_api_key`, `notify.email.password`, `notify.telegram.token`, `notify.discord.webhook`, `notify.discord.token`, `mcp.token`, and `source/<id>` for each feed login. A key set directly in its own environment variable, such as `JUHANDU_CHAT_KEY`, wins over the stored secret.

Discord delivery has two ways, chosen on the Connect screen. Posting to a channel uses the webhook address, stored as `notify.discord.webhook`. A direct message uses a Discord bot's token, stored as `notify.discord.token` or handed in as `JUHANDU_SECRET_NOTIFY_DISCORD_TOKEN`, along with your Discord user id, which is kept with the other settings because it is not secret. To copy your user id, turn on Developer Mode in Discord, then right-click your name and choose Copy User ID. Discord delivers the direct message only when the bot shares a server with you and your privacy settings allow direct messages from that server's members. Both secrets can be stored at once, and only the chosen way's secret is used.

## Command-line tools

`node src/secrets/cli.ts` manages the secret store:

```
node src/secrets/cli.ts status
node src/secrets/cli.ts has <name>
node src/secrets/cli.ts set <name>
node src/secrets/cli.ts delete <name>
```

`status` lists the backends and whether each is available and writable. `set` reads the value from standard input so it stays out of your shell history, for example `type key.txt | node src/secrets/cli.ts set chat/key` on Windows or `node src/secrets/cli.ts set chat/key < key.txt` elsewhere. No command prints a secret's value.

`node src/training/cli.ts status` shows how many practice questions each kind of decision has, and `node src/training/cli.ts export [--lane same_story,pipe_ask,wants] [--private] [--out FILE]` writes them as JSONL. It reads the database and sends nothing anywhere. Items from private feeds are included only with `--private`.

`node src/mcp/stdio.ts` connects an MCP client that speaks standard input and output to a running Juhandu.

## The practice-question format

The training export and the Teach your own judge downloads write one JSON object per line. Each row holds one yes or no question in the form the typed-decision protocol uses, so a model trained on the rows sees the same requests the `typed` judge sends.

| Field | What it holds |
| --- | --- |
| `id` | A stable identifier for the row. |
| `lane` | The kind of decision: `same_story`, `pipe_ask` or `wants`. |
| `ts` | When the decision or vote was made. |
| `state` | The question and the facts it concerns. |
| `questions` | The question asked both ways, as `answer` and `inverse`. |
| `human` | Your vote, as `answer` and `inverse` booleans. Present on `wants` rows. |
| `teacher` | The hosted Jev answer, as probabilities. |
| `local` | A typed server's shadow answer, as probabilities. |
| `note` | The reason you gave with a vote, when there is one. |

The `wants` rows come from your likes and dislikes. The `same_story` and `pipe_ask` rows come from logged decisions and appear only for questions Jev answered, since its answer is their label. A row belongs to the test side when sha1 of its `id`, read as a number, is divisible by 5, and to the training side otherwise, so a row stays on the same side in every export.
