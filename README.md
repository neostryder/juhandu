# Juhandu

Juhandu is a self-hosted feed reader that reads your feeds for you. It polls RSS, Atom and JSON feeds, YouTube channels and playlists, and ordinary sites it can find a feed for. It hides what your rules say to hide, learns what you like from your votes, writes a one-sentence summary of each item it shows, merges the same story from several sources into one line, and has a briefing ready each morning. It runs as one Node process with one SQLite file and serves a web app you can install on a phone or desktop and read offline.

The AI parts run on a model server on your own machine or on any OpenAI-style endpoint you point it at. Without a model, Juhandu still works as a reader: rules that need no model keep hiding and sorting items, and briefings and pipes show headlines in place of summaries.

## There is no sign-in yet

Juhandu has no accounts and no password today, and sign-in is planned for a later release. Until then, anyone who can reach the port can read your feeds, change your rules, replace feed logins and see your settings. The server listens only on 127.0.0.1 by default and prints a warning at start-up if `JUHANDU_HOST` points it anywhere else. If you expose it to a network, put a reverse proxy that authenticates every request in front of it, such as Cloudflare Access, and set `JUHANDU_PUBLIC_HOST` to the proxy's public name; without it, the web app's API calls through that name are refused. [docs/SETUP.md](docs/SETUP.md#running-behind-a-reverse-proxy) shows the setup, and [SECURITY.md](SECURITY.md) has the details.

## What it does

### Feeds

Paste a feed address or a site address on the Reading screen. Juhandu looks for the site's advertised feed and then tries the usual paths such as `/feed`, `/rss.xml` and `/atom.xml`. A YouTube channel, `@handle` or playlist address becomes that channel's or playlist's video feed. Feeds are polled every 30 minutes with conditional requests. A feed that keeps failing is retried less often, down to once a day, and never sooner than the site's `Retry-After` asks.

A feed that needs a login can use a private link, a user name and password, a request header or a session cookie. The login is kept in the secret store, the database holds only a masked copy of the address, and the login is sent only to the site it was given for. The Feeds screen shows a lock on these feeds with Replace login and Remove login.

Every feed has a tier, public or private, which decides where its items may be sent (see Privacy below). A feed added on the Reading screen is public and has no folder. An OPML import sets one tier for all the feeds it brings in and keeps their folders, and `POST /api/sources` accepts `tier` (`public` or `private`) and `folder` for a single feed. There is no screen yet for changing the tier or folder of a feed that already exists.

### Importing from another reader

The Feeds screen imports an OPML file from Inoreader or any reader that exports one, up to 2000 feeds. Folders come along, with nested folders joined by ` / `, and a preview lets you untick feeds and pick the tier for the whole import. Nothing is fetched during the import; the poller picks the new feeds up on its next rounds. Once they have come in, a catch-up step offers to build a briefing from everything unread and then to mark it all read. A feed whose address carries a login (a name and password before the host, or a query value under a name such as token, key, secret, auth, or session) comes in as a private link: it goes in the private tier whatever tier you picked, the feed list shows only its host, and the real address is kept in the secret store and never appears in the preview. If no secret store is set up, those feeds are skipped and the result says how many.

### Rules

A rule can hide an item, favor or demote it, or always show it. Its conditions can be keywords (any or all, over the title, text or author), a regular expression, a domain (which also matches its subdomains), or a sentence the item should resemble, with optional examples and counter-examples. A rule applies to everything, to one folder or to one feed. Hide always wins, an always-show rule overrides favor and demote, and enough demotion hides an item on its own.

Before a rule goes live you can preview it against the 200 most recent items. A rule can also be tried quietly, which counts what it would match and changes nothing. Word lists and domain blocklists can be imported as rules: the domain importer reads bare domains, hosts-file lines, `||example.com^` and `*.example.com` entries, up to 20,000 of them. Hidden items go to the Filtered out screen, which names the rule that hid each one and has a Restore button.

### Learning your taste

Every item gets an embedding from your embedding model. Like or dislike an item and, if you want, add a one-line reason. Juhandu uses your votes to order the briefing; taste alone never hides anything. Now and then the Reading screen asks about an item the model is unsure of, at most three a day by default, and the Rules screen changes the number or switches it off.

When enough of your votes point the same way, a model drafts a rule from them, tests it against your past votes and offers it on the Rules screen. An accepted proposal is tried quietly until it passes a promotion meter: 30 votes at 95 percent agreement, or 50 votes at 98 percent for a rule that would match a tenth or more of your items. A live learned rule still lets 1 in 20 of its matches through so you can check it is still right. Proposals need both a chat model and an embedding model.

### Summaries and stories

Each item that is shown gets a one-sentence summary of at most 240 characters, along with a quote from the item that backs it up. Juhandu checks the quote against the item's own text, and a summary whose quote is not found is marked unchecked. Item text that tries to give instructions to the model is flagged. An item with too little text to summarize shows its headline instead.

When several feeds carry the same story, Juhandu finds likely pairs by embedding similarity, asks the judge whether they are the same story, and merges them into one briefing entry with one line and links to every source.

### Briefings

A daily briefing is built once a day after the hour set by `JUHANDU_BRIEFING_HOUR` (7 by default, in the server's local time). It covers the last 24 hours of unread items, up to 12 per folder, with pinned items first, then by taste, then by time. The Briefing screen has Write my briefing for an on-demand one and Plain text for a Markdown copy. Briefings are stored, and the catch-up briefing covers everything unread.

### Pipes

The Pipes screen builds new feeds from your existing ones with a form. A pipe reads everything, one folder, one feed or another pipe, then runs steps in order: filter on a field, keep items newer than an age, remove duplicates by address or title, sort, limit (overall or per feed), find and replace, add a tag, use the summary as the text, and ask the model a yes or no question about each item (up to three questions per pipe). A pipe can be published as an Atom feed at `/pipes/<slug>.xml`, unless it reads a private feed.

### Delivery

The Connect screen sends the daily briefing by email, Telegram or Discord. Email goes through Juhandu's own SMTP client (STARTTLS on port 587 by default, or TLS, or none for a local relay), and it will not send a password over an unencrypted link to anything but this machine. Discord delivery either posts to a channel through a webhook or has a Discord bot send you a direct message. Items from private feeds are left out of every message by default; email can be told to include them, and Telegram and Discord never can. A failed send is retried up to three times. Only the latest daily briefing from the past 30 hours goes out automatically, and Send the latest briefing now sends one by hand.

### AI assistants

Juhandu has an MCP server so an AI assistant can read your briefing, items, feeds, rules and pipes. It answers at `/mcp` over HTTP, and `node src/mcp/stdio.ts` bridges it to assistants that speak MCP over standard input and output. The Connect screen can create an access token, which is shown once; once a token exists, every request must carry it. Without a token, the endpoint answers only programs on this machine, so a request through a proxy or one addressed to a name in `JUHANDU_PUBLIC_HOST` needs the token. Letting assistants vote, mark items read or build a briefing is off by default, and so is letting them see private feeds.

### Videos

For a single YouTube video, Juhandu reads the video before summarizing it, trying three ways in order. Gemini can read a public video from its address with your Google API key. The video's captions can be fetched with yt-dlp and digested by your chat model. Juhandu can also pull the audio and a few frames itself with yt-dlp and ffmpeg and send them to a speech server and a vision server you configure; this way skips videos over an hour long. The Connect screen sets up each way, tests it, and says why any of them is off.

### Teaching your own judge

Every yes or no, pick-one and rank decision a model makes is logged in the database with the question and the model that answered. The Connect screen's Teach your own judge section turns these logs and your votes into practice questions for training a small local judge, with one download for each kind of decision: whether two items are the same story, the questions your pipes ask, and whether you would want to read an item. Items from private feeds are left out of those downloads. [docs/SETUP.md](docs/SETUP.md) describes the file format.

### The web app

The screens are Briefing, Reading, Filtered out, Rules, Feeds, Pipes, and Connect. On a narrow screen a tab bar runs along the bottom with the rest under More. The theme follows the system, and a button switches between system, light and dark. The app installs from the browser, and offline it shows the last items and briefings it loaded, marked as a saved copy.

## Requirements

Juhandu needs Node 26 or newer. Node runs the TypeScript source directly by stripping the types, so there is no build step, and Juhandu has no runtime npm dependencies ([DEPENDENCIES.md](DEPENDENCIES.md) lists what it does use).

AI features need an embedding model and a chat model, on your own machine or behind an OpenAI-style API. The video reader can also use yt-dlp, ffmpeg, a Google API key for Gemini, a speech-to-text server and a vision server. All of these are optional.

## Getting started

```
git clone https://github.com/neostryder/juhandu.git
cd juhandu
npm start
```

Open http://127.0.0.1:8787 and add a feed from the Reading screen. Data goes in a `data` folder in the project unless `JUHANDU_DATA` names another one. `npm install` is needed only for the type checker.

Until its steps are done or it is hidden, a short Getting started list on the Briefing and Reading screens covers the first steps: add a feed, connect a chat model, set up video reading, and choose where the briefing goes. Each step links to the place that does it.

Juhandu also runs in Docker. From the project folder, this builds the image and starts it on http://127.0.0.1:8787:

```
docker compose up -d --build
```

[docs/SETUP.md](docs/SETUP.md#running-in-docker) covers settings, secrets, model servers on the host, video tools and upgrades for the container.

## Connecting models

The Connect screen connects models while Juhandu runs: it saves each key in the secret store, tests the connection, and applies the change without a restart. Environment variables work too, and they win over anything saved on the screen. To turn on the AI features that way, point `JUHANDU_EMBED_URL` and `JUHANDU_CHAT_URL` at any OpenAI-style embedding and chat endpoints, such as a model server running on this machine. The start-up log says which model adapter Juhandu chose, or that AI features are off. [docs/SETUP.md](docs/SETUP.md) lists every setting, explains the judges and the optional integrations, and covers secrets and the command-line tools.

## Privacy

Every feed is public or private. Public items may go to any model endpoint you configure. Private items go only to endpoints on this machine and to endpoints you name in `JUHANDU_PRIVATE_ALLOW`. An endpoint counts as on this machine when its address is a loopback address, unless its `_LOCAL` variable or its switch on the Connect screen says otherwise. Cogitator and typed-decision servers are always treated as local, so point them only at machines you control. Gemini only ever sees public videos, and Telegram and Discord never receive private items.

The server contacts the feeds you subscribe to, YouTube when you add a channel or playlist, and the services you configure. The web page loads two fonts from Google Fonts, so your browser contacts fonts.googleapis.com and fonts.gstatic.com; without them the app falls back to fonts already on your device.

## More

- [docs/SETUP.md](docs/SETUP.md): settings, models, judges, secrets and command-line tools.
- [SECURITY.md](SECURITY.md): what the server exposes and how to report a vulnerability.
- [CONTRIBUTING.md](CONTRIBUTING.md): how to work on the code.
- [AI_USAGE_POLICY.md](AI_USAGE_POLICY.md): how AI is used to build Juhandu and what the running reader sends to models.
- [DEPENDENCIES.md](DEPENDENCIES.md): the development packages, optional programs and services.
- [CHANGELOG.md](CHANGELOG.md): what has changed.

## The name

Juhandu is a word coined from two Guarani roots, juhu ("to find") and andu ("to feel" or "to perceive"). Read together they mean roughly "find and perceive", which is the program's job with feeds: it finds the items and works out which ones matter. Guarani speakers do not use the word, and no Guarani speaker has checked it yet. If you speak Guarani and see a mistake, please open an issue.

## License

Juhandu is licensed under the GNU Affero General Public License, version 3 only. If you run a modified copy for other people over a network, you must offer those people the source code of your modified version.
