# Security

## Reporting a vulnerability

Report a vulnerability privately through https://github.com/neostryder/juhandu/security/advisories/new, not as a public issue. Include the version or commit, what an attacker can do, and the steps to reproduce it.

## What listens

Juhandu runs one HTTP server on `JUHANDU_HOST` and `JUHANDU_PORT`, which default to 127.0.0.1 and 8787. That one port serves the web app, the JSON API under `/api/`, the MCP endpoint at `/mcp`, and published pipes at `/pipes/<slug>.xml`. Published pipes are served whatever the `Host` header says, so feed readers elsewhere can fetch them. The server speaks plain HTTP, so HTTPS comes from a reverse proxy in front of it.

## There is no sign-in yet

Juhandu has no accounts or password today. Sign-in is planned for a later release. Until then, anyone who can reach the port can read your feeds and briefings, change rules and settings, replace feed logins, and send the briefing through your delivery channels. The server prints a warning at start-up when `JUHANDU_HOST` is anything other than `127.0.0.1`, `::1` or `localhost`.

Keep the default address, or put a reverse proxy that authenticates every request in front of Juhandu, such as Cloudflare Access. Opening the port to a network without one gives that network full control of your reader.

The JSON API under `/api/` checks where each request comes from. It answers only when the `Host` header is `localhost`, `127.0.0.1`, `[::1]` or a name listed in `JUHANDU_PUBLIC_HOST`, and when any `Origin` header names one of those hosts too. Anything else gets a 403. A request that sends a body must send it as `application/json`, or it gets a 415. These checks stop a web page on another site from using the API through your browser, and they stop DNS rebinding, where a hostile name is pointed at your machine. They do not authenticate anyone: whoever can reach the port and send a matching `Host` header still has full control. Behind a reverse proxy, set `JUHANDU_PUBLIC_HOST` to the public name the proxy serves, or the web app's own requests are refused.

The MCP endpoint has its own guard. Once an access token is created on the Connect screen, every request must carry it as a bearer token, and the token is compared in constant time. Without a token, the endpoint answers only requests whose `Host` is this machine or a name in `JUHANDU_PUBLIC_HOST` and whose `Origin`, when present, is this machine. Letting assistants make changes or see private feeds is off by default.

## What is stored and where

Everything except secrets lives in one SQLite file, `juhandu.sqlite`, in the data folder, which is `JUHANDU_DATA` or by default `data` in the project. That file holds your feeds, items, summaries, votes, rules, pipes, briefings, settings, delivery history and the log of model decisions. Anyone who can read that file can read your feeds.

Model API keys, feed logins, the email password, the Telegram token, the Discord webhook and the MCP token live in the secret store. The store reads environment variables, Bitwarden Secrets Manager, the operating system's credential store, or a folder of files readable only by the owner, and [docs/SETUP.md](docs/SETUP.md) explains the order. A secret is never written to the database, returned by the API or printed in a log. Every secret the store reads or writes is registered with a redactor, and error messages that might contain one pass through it before they are logged or saved. A secret travels to a helper program on standard input, never on its command line. `node src/secrets/cli.ts` reports whether a secret is set and never prints its value.

## Feed logins

A feed can log in with a private link, a user name and password, a request header or a session cookie. The login is kept in the secret store under `source/<id>`. For a private link, the database holds only the site's origin and a random marker, and the API shows only the origin. Login headers go only to the origin the feed was added with: redirects are followed one at a time, and a redirect to another origin is fetched without the login. A login header cannot replace `Host`, `Cookie`, `Content-Length`, the proxy headers or other headers that control the connection. In the web app, login fields are password inputs that are cleared after saving, and the server only ever says whether a login is set.

## Where data goes

The server contacts the feeds you subscribe to, YouTube when you add a channel or playlist and when the video reader reads a video, and the services you configure, such as model endpoints, Gemini, the Jev service or a delivery channel. [DEPENDENCIES.md](DEPENDENCIES.md) lists every service and what it is sent. The web page loads two fonts from Google Fonts, so your browser contacts fonts.googleapis.com and fonts.gstatic.com.

Every feed is public or private, and every request to a model endpoint passes through one egress gate in `src/models/egress.ts`. The gate sends a private item only to endpoints on this machine and to endpoints named in `JUHANDU_PRIVATE_ALLOW`. An endpoint counts as on this machine when its address is a loopback address, unless its `_LOCAL` variable says otherwise, and Cogitator and typed-decision servers always count as local. Gemini receives only public videos, Telegram and Discord never receive private items, email includes them only when you turn that on, and a pipe that reads a private feed cannot be published.

## Response headers

Every response carries `X-Content-Type-Options: nosniff`, so browsers do not guess content types. It carries `Referrer-Policy: no-referrer`, so a link followed from the web app tells the next site nothing about where it came from. It carries `X-Frame-Options: DENY`, so no other site can put the app in a frame.

Every response also carries a `Content-Security-Policy` with these directives:

- `default-src 'self'` limits everything not listed below to the server itself.
- `img-src 'self' https: data:` lets images come from the server, from any HTTPS address, or from data URIs.
- `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` allows the server's styles, inline styles, and the Google Fonts stylesheet.
- `font-src https://fonts.gstatic.com` allows fonts only from Google Fonts.
- `frame-ancestors 'none'` stops any page from embedding the app.

Scripts load only from the server itself. Images may come from any HTTPS address, since feed items carry their own pictures. API responses are sent with `Cache-Control: no-store`, and request bodies over 64 KB are refused, except blocklist and OPML imports, which may be up to 4 MB.
