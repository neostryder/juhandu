# Contributing to Juhandu

Juhandu is one Node process, one SQLite file and a web app with no build step. Changes keep that shape: no second service, no separate database server, no bundler.

## Setting up

You need Node 26 or newer. Clone the repository and run `npm install`, which brings in the two development dependencies, TypeScript and the Node type definitions. Nothing else is installed, because Juhandu has no runtime npm dependencies.

```
npm start           # runs node src/main.ts on http://127.0.0.1:8787
npm test            # runs every test under test/ with node --test
npm run typecheck   # runs tsc --noEmit over src, test, web and scripts
```

To run one file, use `node --test test/rules.test.ts`. Point `JUHANDU_DATA` at a scratch folder when you start a copy for testing, so it does not touch your own database.

## Where things are

`src/main.ts` wires everything together and runs the main loop once a minute: poll due feeds, embed and judge new items, summarize, merge stories, answer pipe questions, propose rules, promote rules that have passed the meter, build the daily briefing when it is due, and deliver it. The video reader runs on its own loop.

The rest of `src` is split by job: `sources` (fetching, parsing, discovery, feed logins), `ingest`, `import` (OPML), `rules`, `taste`, `proposals`, `pipeline`, `summarize`, `briefing`, `pipes`, `judges`, `models` (the model adapters and the egress gate), `video`, `notify`, `mcp`, `training`, `secrets`, `store` and `api`. The browser code is in `web`, and the tests are in `test`.

## Code conventions

Server code is TypeScript that Node runs directly by stripping the types. The compiler runs with `erasableSyntaxOnly`, so write nothing that needs code generated for it: no enums, no namespaces with values, and no constructor parameter properties (declare the field and assign it in the constructor). Imports use the `.ts` extension, and type-only imports use `import type`.

Browser code in `web` is plain JavaScript checked by the same compiler. Each file starts with `// @ts-check` and carries its types in JSDoc comments. Screens are web components built on the platform's own `customElements`; there is no framework.

Tests use `node:test` and `node:assert`. Storage uses `node:sqlite`. Before reaching for a package, use what Node and the browser already provide. A new dependency, runtime or development, needs a reason in the pull request, and a runtime dependency needs a strong one.

All prose, comments and UI strings use plain ASCII punctuation: straight quotes, hyphens, three dots for an ellipsis, and no long dashes.

## The database

The schema lives in the `MIGRATIONS` array in `src/store/store.ts`. The database's `PRAGMA user_version` records how many entries have run, and at start-up every newer entry runs in its own transaction. Migrations are only ever appended. Never edit or reorder one that exists, because databases in the wild have already run it.

A change to anything stored, whether a new table, a new column or a different shape of JSON in an existing column, needs a new migration and a test that opens a database at the old version and checks the result.

## Tests

Every change ships with a test, and `npm test` and `npm run typecheck` must both pass before a pull request is ready. Tests run against real parsers and real SQLite databases, and they replace the network with fake servers or an injected `fetch`. A test never calls a hosted model or any other service on the internet.

A regression test should fail without the change it protects. Check that by undoing the change, watching the test fail, and putting the change back.

## Secrets and private feeds

Secrets are never printed, logged, returned by the API or stored in the database. They go through the secret store in `src/secrets`, and an error message that might contain one passes through the store's redactor before it is logged or saved. A form field for a secret is a password input that is cleared after saving, and the server only ever says whether a secret is set.

Every feed is public or private, and an item from a private feed must never reach a hosted endpoint. Every request to a model leaves through the egress gate in `src/models/egress.ts`. A change to the gate, to an endpoint's local flag, or to any code that sends item text, audio or frames somewhere needs a test showing that a private item is refused where it should be.

## Commits and pull requests

A commit subject names the change in the imperative, such as "Add the OPML importer and catch-up flow". Add a body when the reason for the change is not obvious from the diff.

Keep a pull request to one change. Say what it changes for someone running Juhandu and how you tested it. If the change is visible to users, add an entry under `## [Unreleased]` in `CHANGELOG.md` in the format that file describes. A new or changed environment variable goes in the settings tables in `docs/SETUP.md` in the same pull request.

Pull requests written with AI help are welcome. [AI_USAGE_POLICY.md](AI_USAGE_POLICY.md) says what to disclose and the bar every change has to meet.

## Reporting a security problem

Report a security problem privately through https://github.com/neostryder/juhandu/security/advisories/new instead of opening a public issue. [SECURITY.md](SECURITY.md) describes what the server exposes today.

## License

Juhandu is licensed under the GNU Affero General Public License, version 3 only, and contributions are accepted under the same license. If you run a modified copy for other people over a network, you must offer them the source code of your modified version.
