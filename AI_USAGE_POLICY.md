# AI use in Juhandu

Juhandu is written with a lot of help from Claude, Anthropic's model, used mostly through Claude Code. The running reader also calls models of its own to sort and summarize feed items. The first part of this file covers how code gets written and checked; the second lists what the product sends to models and where private items can never go.

## How Claude is used in development

Claude drafts and revises the TypeScript, the tests and the documentation. It also takes on the tedious work: an edit that has to land across many files, tracing a value through the pipeline, chasing down why a test fails.

What it produces stays a draft until the maintainer has read it. The maintainer decides whether a change is correct, whether a design or a new dependency belongs in the project, what data may leave the owner's machine and when a release is ready. No change is merged because a model wrote it, explained it convincingly, reviewed it or reported that its tests passed. Whoever merges a change has to be able to say what it does, why it is needed, what it assumes and how it was tested.

Secrets, credentials and private data are never given to an AI service as development context. Any dependency or API a model suggests is checked independently before use, since invented APIs and needless packages are common in model-written code. Security review also watches for unsafe defaults, and for code that does what the prompt asked while breaking a rule the prompt never mentioned.

The app icon is an image made with ChatGPT, OpenAI's assistant, then cropped and resized by hand into each icon size the app ships.

## What has to pass

Two commands gate every change, and both must pass. `npm test` runs every `*.test.ts` file under `test/` with Node's built-in test runner. `npm run typecheck` runs the TypeScript compiler in strict mode over the server code in `src/`, the browser code in `web/`, the scripts and the tests.

The tests use the real feed parsers, real SQLite databases and the real egress gate. Model servers, feed servers and mail servers are replaced by fakes that answer the way the real ones do, so a test can check what Juhandu sent and what it did with the reply. No test calls a hosted model or anything else on the internet.

A test written by the same model that wrote the code can share the code's mistake. For that reason a test drafted with AI help has to be shown to fail without the change it protects: revert the change and watch the test fail, then restore it and watch it pass. Expected values in a test come from the feed format, the protocol or the behavior the feature promises, and never from a model's account of what the code ought to do.

## Contributing with AI tools

Pull requests written with AI help are welcome and get the same review as any other. If a tool wrote a substantial part of yours, beyond ordinary editor completion, say so in the pull request description. Naming the tool is enough. It does not count against the pull request; it tells reviewers where to read more closely.

You must be able to explain every line you submit. A pull request can be sent back if its author cannot explain it, cannot settle a licensing question about it or cannot show that it is tested, and hand-written pull requests are held to the same bar.

## Licensing

Juhandu is licensed under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). Model output gets no exemption from copyright, license or attribution rules, and a model's claim that code is original or safe to reuse is not evidence that it is. When a suggestion looks like recognizable third-party code or pulls in a new dependency, the licensing question is settled before the code goes in. Anything still unclear is rewritten or left out.

## AI in the running product

Juhandu calls models for embeddings, summaries, rule proposals, story merging, questions asked in pipes and reading videos. The owner picks every model it talks to: any OpenAI-style endpoint works, and so does Cogitator, an optional local model host that is not publicly available yet. With no model configured the AI features stay off, and the reader keeps working along with the rules that need no model, the briefings and the pipes.

### What each endpoint receives

The embedding endpoint gets each item's title, author and the first 1200 characters of its text, plus the sentences and examples written into semantic rules.

What the chat endpoint gets depends on the job:

- To write a summary: the item's title and up to 3000 characters of its text, or up to 6000 characters when a reading of the item's video exists.
- To decide whether two items are the same story: the titles and opening text of both.
- To write a story's line: the text of the merged items.
- For a pipe's ask step: the question, plus the title, feed name and first 600 characters of the summary or text of each item the step covers.
- To draft a rule: the titles and written reasons behind a group of votes.

Judges named in `JUHANDU_JUDGE` or `JUHANDU_JUDGE_SHADOW` get the same questions the chat model would. A judge can be a typed-decision server the owner runs, or the hosted Jev service.

For a video, Gemini receives the address of a public video and the chat endpoint receives its captions. The speech and vision endpoints the owner configures receive its audio and a few still frames.

### Private feeds and secrets

An item from a private feed never goes to a hosted endpoint unless the owner names that endpoint in `JUHANDU_PRIVATE_ALLOW`. Every request to a configured endpoint passes through one egress gate, which lets a private item through only to endpoints on the same machine or to the endpoints named there. Cogitator and typed-decision servers count as being on the same machine. Gemini only ever receives public videos. Telegram and Discord never receive private items, and email receives them only when the owner turns that on.

API keys, feed logins and passwords stay in the secret store and go only to the service each one belongs to. None of them is ever sent to a model.

### The decision log

Each yes-or-no, pick-one or rank decision a model makes is written to the database with the question, what the model was shown, its answer, the model, the provider and the data tier. Judges listed as shadows answer the same questions, and their answers are logged without changing anything. The Teach your own judge section of the Connect screen turns these decisions and the owner's votes into practice questions for training a small local judge, and leaves private items out. Building those files sends nothing anywhere.

Every summary keeps the quote that supports it. When that quote cannot be found in the item, the briefing shows the summary with an "unchecked" badge. Item text that tries to give the model instructions is flagged.

### Running on your own machine

Every model Juhandu uses can run on the owner's own hardware. Embeddings, summaries, judging, captions, speech and frames all go through endpoints the owner configures, and none needs a hosted service. Gemini is optional; set `JUHANDU_GEMINI=off` to switch it off.

## Limits and criticism

Passing tests do not prove the code has no bugs. This file also makes no claim that generative AI is error-free, free of environmental cost, ethically settled or right for every project, and users and contributors are not asked to share the maintainer's view of it.

Open an issue if a test is too weak, a dependency looks wrong, a licensing question is unresolved, data reaches a model it should not, or this file no longer matches what the code does. General opposition to generative AI is a fair position to hold. The project's use of it is disclosed here, and it is not reargued in each issue or pull request.
