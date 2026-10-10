# Changelog

All notable changes to Juhandu are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- [Visible] [Security] **The server listens on 127.0.0.1 by default and warns at start-up when it is set to listen anywhere else.** Juhandu has no sign-in, so the warning recommends a reverse proxy with authentication.
- [Visible] [Security] **The API refuses requests from other sites, requests addressed to unexpected host names, and bodies that are not JSON.** Only this machine's own names and those in `JUHANDU_PUBLIC_HOST` are answered, which blocks web pages and DNS rebinding from using it through your browser, so a reverse proxy with a public name needs that name in `JUHANDU_PUBLIC_HOST`.
- [Visible] [UI] **A web app with Briefing, Reading, Filtered out, Rules, Feeds, Pipes and Connect screens.** It follows the system's light or dark theme, shows a tab bar on phones, installs from the browser, and shows the last loaded items and briefings when offline.
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
