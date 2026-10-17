# Changelog

All notable changes to Juhandu are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- [Visible] [UI] **Each feed has a tier, a folder, and a check interval, set when it is added and changeable later.** The add box on Reading has a Folder box and a menu for who may read the feed's text: Public lets a hosted model read it, and Private keeps it to local models. The Feeds screen labels private feeds and gives every feed an Edit control for its tier, its folder, and how often it is checked, anywhere from every 5 minutes to once a day. Items follow their feed's tier right away, so once a feed is private, hosted models stop seeing its text. In the API, `PATCH /api/sources/<id>` takes `folder`, `tier`, and `pollMinutes` (a whole number from 5 to 1440), and fields left out stay as they were.
- [Visible] [Compatibility] **An iCalendar (.ics) address can be added like any feed.** Each event becomes an item named after its summary, and the item's text holds the start time, the place, and the description. Start times with no zone are read as UTC. Items are dated when Juhandu fetched them, so an upcoming event shows up as new. Reminder (alarm) text is dropped, and only http and https event links are kept. A calendar address with a private token in it is added as a private link, so the token never ends up as an item link. Trakt's personal shows calendar is one that works.

### Changed

- [Visible] [UI] **The open app checks for new items every five minutes instead of every minute when the browser asks to save data.**

## [0.3.0] - 2026-10-16

### Added

- [Visible] [UI] **Reading can be triaged by swipe or keyboard.** On a touch screen, swiping an item right Likes it and swiping left Dislikes it, and a swipe starts only on the card body, never on its buttons or links. On a keyboard, j and k move between items, l likes, d dislikes, o opens, and r refreshes. The shortcuts button in the Reading toolbar turns both the keys and the swipes off or back on.
- [Visible] [UI] **Pulling down at the top of Reading on a phone refreshes it.** While the app is open it also checks for new items every minute and shows a "N new. Show them" pill, so the list stays put under the item being read.
- [Visible] [UI] **The home-screen icon shows the unread count and has shortcuts.** On systems that support app badges, the installed icon carries the number of unread items. A long press on it opens Briefing, Reading, Filtered out, or Add a feed.
- [Visible] [UI] **Juhandu appears in the phone's share sheet.** Sharing a link to it opens Add a feed with the address already filled in.
- [Visible] [Compatibility] **The `jev` judge can send its requests through an Augur Jev gateway.** With `JUHANDU_JEV_GATEWAY_URL` and `JUHANDU_JEV_GATEWAY_TOKEN` (or `JUHANDU_JEV_GATEWAY_TOKEN_FILE`) set, every Jev request goes to the gateway first, and private items are marked sensitive so the gateway keeps them off hosted Jev. A request goes straight to hosted Jev only when the gateway cannot be reached or fails on its own and a direct key is set, and never after the gateway refuses it. The gateway alone is enough to turn on the `jev` judge.
- [Visible] [Backup] **A nightly copy of the database can go to an S3-compatible bucket such as Cloudflare R2.** `scripts/backup-to-r2.sh` runs on the Docker host, takes a consistent copy while Juhandu keeps running, and can download the newest backup for a restore.

### Changed

- [Visible] [UI] **Reading shows 40 items at a time and loads more while scrolling.** The next 40 arrive as the list nears the bottom, and "That is everything." marks the end. Rows outside the screen are not drawn, so long lists scroll smoothly.
- [Visible] [UI] **The app opens faster.** The Rules, Feeds, Pipes, and Connect screens load when first opened, and they are fetched quietly in the background after start. The scripts the first screen needs are preloaded, and the web fonts no longer hold up the first paint.
- [Visible] [UI] **Every screen fits a phone without sideways scrolling.** The browser's own pull-to-refresh and bounce no longer compete with the app's, the tap highlight is gone, and the Getting started links are easier to tap.
- [Visible] [UI] **Juhandu has a new home-screen and browser-tab icon, a golden herald's horn with a burgundy banner.** The icon is a photographic image in 192 and 512 pixel sizes, with a separate maskable version that fits Android's circular and rounded crops, and it replaces the drawn seal icon and the script that generated it. A phone fetches a linked icon without the sign-in cookie, so behind an access proxy the old icon links got a login page back and the home screen showed a plain letter tile; the page now carries its small icons inside itself, so they always load.

- [Visible] [Compatibility] **Juhandu embeds text with EmbeddingGemma 2 through Cogitator's `embed-gemma2` role.** A gateway without that role gets the requests on its `embed` role (Nomic Embed Text v1.5), as before. Vectors from different models are never compared, so the first run after the upgrade embeds every item again in the background. Each item keeps its old vector until the new one is ready, and nothing waits on the work. Each model now gets the prefixes it was trained with: EmbeddingGemma 2 puts "title: none | text: " before items and "task: search result | query: " before rule sentences and examples, and other models keep "clustering: " for both. `JUHANDU_EMBED_DOC_PREFIX` and the new `JUHANDU_EMBED_QUERY_PREFIX` override them, and the new `JUHANDU_COGITATOR_EMBED_ROLE` names the role that embeds text. Two cutoffs moved so they let through about as many pairs as before. Two items now need a similarity of 0.82 (was 0.8) before the judge is asked whether they are the same story, set by `JUHANDU_MERGE_SIMILARITY`, and two voted items count as the same topic for rule proposals at 0.75 (was 0.72).

### Fixed

- [Visible] [Compatibility] **Embeddings answered by another machine in a Cogitator role's chain are accepted.** Cogitator can name the serving model with its machine attached, such as `embeddinggemma-2@bilbo`, and Juhandu used to read that as a different model and discard the vectors. It now ignores the machine name.
- [Visible] [Compatibility] **A single private or restricted YouTube video no longer pauses Gemini for an hour.** When Google answers a video request with a 403, Juhandu checks the key with a plain request that names no video, and pauses Gemini only if that request is refused too; otherwise only that video is marked as one Gemini cannot read, and the next video goes to Gemini as usual. A 401 or an invalid-key 400 still pauses Gemini at once.
- [Visible] [Compatibility] **Screens loaded on demand now carry the version in their address.** Before this, an upgrade could leave a cache serving the old copy of a screen.
- [Visible] [Compatibility] **The home-screen manifest is now requested with the sign-in cookie.** Behind an access proxy, the phone now finds the app's name and icon instead of a login page.
- [Visible] [Security] **Assistant write tools only change items the assistant can read.** The vote_item and mark_read MCP tools leave items from private feeds untouched unless private feeds are turned on for the assistant.
- [Visible] [Security] **Rule proposal drafts go to the model at the private tier whenever they include a title from a private feed.** Every liked or disliked title in the request now sets the tier, where before only the items being clustered did.
- [Visible] [Security] **Removing a stored secret clears it from every backend, including an older key file kept beside the current store.** The removal reports an error if any backend could not delete the secret. Removing a feed deletes its stored login first and keeps the feed if that step fails, so the owner can retry.
- [Visible] [Security] **The JSON API now compares the port as well as the host name when it checks a request's Origin.** A request whose Origin names a different port than the Host it was sent to counts as cross-site, even when that host name is allowed. Setups behind a proxy on port 80 or 443 behave as before.

## [0.2.1] - 2026-10-10

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
