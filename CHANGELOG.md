# Changelog

All notable changes to Juhandu are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- [Visible] [Compatibility] **Juhandu can use a Cogitator gateway on another machine.** Requests used to go to the loopback address in the gateway's discovery document and were refused, so items never got summaries. Juhandu now sends them to the host it reached the gateway at.

## [0.2.0] - 2026-10-10

### Added

- [Visible] **Juhandu can run in Docker with the included `Dockerfile` and `compose.yaml`.** The container runs as an unprivileged user, keeps the database and secrets in a data volume, reports its health from `/api/health`, and publishes the port on 127.0.0.1 only. The image includes yt-dlp for reading video captions, and building with `VIDEO_TOOLS=full` adds ffmpeg as well.
- [Visible] [UI] **The Connect screen sets up models and video reading, with a Test button for each.** Chat and embedding endpoints, Cogitator, the Gemini key, and the speech and vision servers can be saved without a restart. Keys go to the secret store, and an environment variable still wins over a saved value. When the Gemini key fails its Test, the card says so until a later Test passes or a new key is saved.
- [Visible] [UI] **A Getting started list on the Briefing and Reading screens tracks the first steps.** It covers adding a feed, connecting a chat model, setting up video reading, and choosing where the briefing goes, and links each step to its screen. Once hidden, it comes back from a button at the top of the Connect screen.
- [Visible] [UI] **Discord delivery can send the briefing as a direct message from a Discord bot.** The Discord card on the Connect screen chooses between posting to a channel through a webhook and a direct message, which needs the bot's token and your Discord user id. Both secrets can be saved, and only the chosen way's secret is used.
- [Visible] [UI] **Keyword and regular expression rules can search an item's link as well as its title, text, and author.** The rule editor has a link checkbox beside the other fields, so a regular expression on the link that matches `youtube.com/shorts/` hides YouTube Shorts.

### Changed

- [Visible] [UI] **The reasons a way of reading videos is off name the fix in plain words.** The Connect screen says when yt-dlp or ffmpeg is missing and how to add it, in Docker or on the host.
- [Visible] [UI] **Small text on several screens is larger, and the light theme's dim accent and the pressed toolbar buttons meet WCAG AA contrast.**

### Fixed

- [Visible] **A new release shows up on the first load, even behind a caching proxy.** Script and stylesheet addresses carry a fingerprint of the app's files, the page is checked with the server on every load, and the offline copy is rebuilt for each release.
- [Visible] [Security] **The MCP endpoint no longer treats a request through a proxy as local.** Without an access token, a request that carries a proxy header such as `X-Forwarded-For` or `Cf-Connecting-Ip`, or that is addressed to a name in `JUHANDU_PUBLIC_HOST`, is refused.
- [Visible] **A Gemini key that Google reports as invalid pauses Gemini for an hour, as a refused key already did.** An invalid key used to be tried again on every video.
- [Visible] [UI] **The AI assistants section describes what assistants can do with the switches as they are set.** It used to say assistants could only read, even when changes were switched on.
- [Visible] [API] **Paging the reading list with `before` (and the MCP tool's `before_id`) now visits every item once.** Pages used to repeat or skip items when published dates and item ids disagreed, as with a feed that backfills older posts. An id that does not exist now returns an empty page instead of the first page again.
- [Visible] [Security] **OPML import no longer stores a login found inside a feed address in the clear.** An address with a name and password before the host, or a query value such as `token` or `key`, is now added as a masked private link with the real address in the secret store, the same as adding one by hand. Without a secret store, those feeds are left out and the import result says how many.

## [0.1.0] - 2026-10-09

### Added

- [Visible] [Security] **The server listens on 127.0.0.1 by default and warns at start-up when it is set to listen anywhere else.** Juhandu has no sign-in, so the warning recommends a reverse proxy with authentication.
- [Visible] [Security] **The API refuses requests from other sites, requests addressed to unexpected host names, and bodies that are not JSON.** Only this machine's own names and those in `JUHANDU_PUBLIC_HOST` are answered, which blocks web pages and DNS rebinding from using it through your browser, so a reverse proxy with a public name needs that name in `JUHANDU_PUBLIC_HOST`.
- [Visible] [UI] **A web app with seven screens: Briefing, Reading, Filtered out, Rules, Feeds, Pipes, and Connect.** It follows the system's light or dark theme, shows a tab bar on phones, installs from the browser, and shows the last loaded items and briefings when offline.
- [Visible] **Feeds can be added by feed address, site address or YouTube address.** Juhandu reads RSS, Atom, RDF and JSON Feed, finds a site's feed on its own, and polls each feed every 30 minutes, backing off when a feed keeps failing.
- [Visible] **Each feed has a tier, public or private, and can sit in a folder.** Private items go only to model endpoints on the same machine or to endpoints listed in `JUHANDU_PRIVATE_ALLOW`.
- [Visible] [Security] **Feeds can use a private link, a user name and password, a request header or a session cookie to log in.** Logins are kept in the secret store and sent only to the site they were given for.
- [Visible] **OPML files from Inoreader or any other reader can be imported with their folders.** A preview comes first, and a catch-up step afterwards builds a briefing from everything unread and offers to mark it all read.
- [Visible] [UI] **Rules can hide, favor, demote or always show items.** Conditions cover keywords, regular expressions, domains and resemblance to a written sentence, a rule can be tried quietly before it acts, and a preview shows what a draft rule would catch among recent items.
- [Visible] **Word lists and domain blocklists can be imported as rules.** The domain importer reads bare domains, hosts-file lines and adblock-style entries.
- [Visible] [UI] **Hidden items appear on the Filtered out screen with the rule that hid them and a Restore button.**
- [Visible] **Likes and dislikes, with an optional one-line reason, teach Juhandu your taste.** Taste orders the briefing and never hides an item by itself.
- [Visible] **The Reading screen sometimes asks about an item the model is unsure of.** It asks at most three times a day by default, and the Rules screen changes the number or switches it off.
- [Visible] **A model proposes rules from groups of similar votes.** An accepted rule is tried quietly until it passes a promotion meter, and a live learned rule still lets 1 in 20 of its matches through as a check.
- [Visible] **Each shown item gets a one-sentence summary backed by a quote from the item.** The quote is checked against the item's text, a summary whose quote is not found is marked unchecked, and an item too short to summarize shows its headline.
- [Visible] **The same story from several feeds is merged into one briefing entry with one line and links to every source.**
- [Visible] **A daily briefing is built each morning after the hour set by `JUHANDU_BRIEFING_HOUR`.** Briefings are stored, can also be written on demand, and have a plain text view.
- [Visible] [UI] **Pipes build new feeds from existing ones with a form.** Steps filter, keep recent items, remove duplicates, sort, limit, find and replace, tag, use the summary and ask the model a yes or no question, and a pipe can be published as an Atom feed.
- [Visible] [Compatibility] **AI features work with any OpenAI-style embedding and chat endpoint, or with Cogitator, an optional local model host.** Without a model, the reader, the rules that need no model, headline briefings and pipes keep working.
- [Visible] **Yes or no, pick-one and rank decisions go through a chain of judges, and every decision is logged.** The chat model judges by default. A typed-decision server you run yourself, or the hosted Jev service, can take over or just log its answers for comparison.
- [Visible] **Videos are read before they are summarized.** Gemini reads public videos by address, captions are fetched with yt-dlp, and the app can send a video's audio and frames to a speech server and a vision server you configure.
- [Visible] **The daily briefing can be sent by email, Telegram and Discord, with retries.** Private items are left out by default, and Telegram and Discord never receive them.
- [Visible] [Security] **An MCP server lets an AI assistant read the briefing, items, feeds, rules and pipes.** Writes and private feeds are off by default, an access token can be required, and `node src/mcp/stdio.ts` connects assistants that use standard input and output.
- [Visible] **The Teach your own judge section on the Connect screen turns your votes and logged decisions into practice questions.** Each JSONL row is labeled by your vote, the Jev answer or a typed server's answer. Private items are left out, and `node src/training/cli.ts` exports the same rows from the command line.
- [Visible] [Security] **Secrets live in a secret store that reads environment variables, Bitwarden Secrets Manager, the operating system's credential store or a folder of files.** They never reach the database, the API or the log, and `node src/secrets/cli.ts` manages them from the command line.
