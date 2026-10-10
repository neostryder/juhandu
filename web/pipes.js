// @ts-check
// The Pipes screen: a pipe takes feeds in, runs steps, and its output is a feed. Built as a form; the pipe is one JSON document, so a graph editor can come later.
// Everything from feeds is shown as text, never as markup.
import { api, baseStyles, el, messageOf } from "./ui.js";

const STYLES = `
  .wrap { max-width: 860px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .head h2 { font-family: var(--font-display); font-weight: 500; font-size: 28px; margin: 0 0 4px; }
  .lede { margin: 0 0 14px; }
  ul.pipes { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  li.pipe { border: 1px solid var(--line); border-radius: 6px; padding: 12px 16px; background: var(--bg-raised); }
  li.pipe h3 { margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 15px; margin: 2px 0 0; overflow-wrap: anywhere; }
  .badge { display: inline-block; margin-left: 8px; padding: 0 8px; border: 1px solid var(--accent-dim); border-radius: 999px; color: var(--accent); font-size: 13px; font-weight: 400; }
  .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
  .row button { min-height: 40px; }
  section.editor { border: 1px solid var(--accent-dim); border-left: 4px solid var(--accent); border-radius: 6px; padding: 12px 18px 16px; margin: 0 0 16px; background: var(--bg-raised); }
  section.editor h3 { margin: 0 0 8px; font-family: var(--font-display); font-weight: 500; font-size: 22px; }
  h4 { margin: 18px 0 6px; font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 400; }
  .line { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
  .line select, .line input[type="text"] { width: auto; flex: 1 1 160px; min-width: 0; }
  .line input[type="number"] { width: 110px; min-height: 44px; padding: 8px 12px; background: var(--bg); border: 1px solid var(--line-strong); border-radius: 3px; }
  .line label.check { display: inline-flex; gap: 6px; align-items: center; }
  .step { border: 1px solid var(--line); border-radius: 6px; padding: 8px 12px 10px; margin: 8px 0; background: var(--bg); }
  .step .top { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .step .top strong { flex: 1 1 200px; font-weight: 600; }
  .step .top button { min-height: 36px; padding: 0 10px; }
  .step textarea { min-height: 64px; }
  .out { margin-top: 12px; }
  .out ol { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 6px; }
  .out li { border-top: 1px solid var(--line); padding-top: 6px; overflow-wrap: anywhere; }
  .out li a { color: var(--text-strong); text-decoration: none; }
  .out li a:hover { color: var(--accent); }
  .out .notes { color: var(--muted); font-size: 15px; margin: 4px 0; }
  code { font-family: var(--font-mono, monospace); font-size: 13px; overflow-wrap: anywhere; }
  [hidden] { display: none !important; }
`;

const INPUT_KINDS = /** @type {[string, string][]} */ ([["all", "Everything"], ["folder", "A folder"], ["feed", "One feed"], ["pipe", "Another pipe"]]);
const STEP_LABELS = /** @type {Record<string, string>} */ ({ filter: "Keep or drop items", "newer-than": "Only recent items", dedupe: "Remove duplicates", sort: "Sort", limit: "Limit", rewrite: "Find and replace", tag: "Add a tag", summary: "Use the one-line summary as the text", ask: "Ask the AI a yes or no question" });
const FIELD_LABELS = /** @type {[string, string][]} */ ([["title", "title"], ["text", "text"], ["author", "author"], ["url", "link"], ["source", "feed name"], ["folder", "folder"], ["tag", "tag"]]);
const TEST_LABELS = /** @type {[string, string][]} */ ([["contains", "contains"], ["not-contains", "does not contain"], ["equals", "is exactly"], ["starts-with", "starts with"], ["regex", "matches the pattern"]]);

/** @param {[string, string][]} pairs @param {string} value @param {(value: string) => void} onChange @param {string} label */
function choice(pairs, value, onChange, label) {
  const select = /** @type {HTMLSelectElement} */ (el("select", { "aria-label": label }, ...pairs.map(([v, text]) => el("option", { value: v, text, selected: v === value }))));
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** @param {string} value @param {(value: string) => void} onInput @param {string} label @param {string} [placeholder] */
function textBox(value, onInput, label, placeholder = "") {
  const input = /** @type {HTMLInputElement} */ (el("input", { type: "text", value, placeholder, "aria-label": label }));
  input.addEventListener("input", () => onInput(input.value));
  return input;
}

/** @param {number} value @param {(value: number) => void} onInput @param {string} label @param {number} min @param {number} max */
function numberBox(value, onInput, label, min, max) {
  const input = /** @type {HTMLInputElement} */ (el("input", { type: "number", value: String(value), min: String(min), max: String(max), "aria-label": label }));
  input.addEventListener("input", () => onInput(Number(input.value)));
  return input;
}

/** @param {boolean} checked @param {(value: boolean) => void} onChange @param {string} text */
function checkBox(checked, onChange, text) {
  const box = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox", checked }));
  box.addEventListener("change", () => onChange(box.checked));
  return el("label", { class: "check" }, box, el("span", { text }));
}

/** @param {any} step */
function newStep(step) {
  switch (step) {
    case "filter":
      return { op: "filter", keep: true, match: "any", conditions: [{ field: "title", test: "contains", value: "" }] };
    case "newer-than":
      return { op: "newer-than", days: 7 };
    case "dedupe":
      return { op: "dedupe", by: "url" };
    case "sort":
      return { op: "sort", by: "date", order: "desc" };
    case "limit":
      return { op: "limit", count: 20, perSource: false };
    case "rewrite":
      return { op: "rewrite", field: "title", find: "", replace: "", regex: false };
    case "tag":
      return { op: "tag", tag: "" };
    case "summary":
      return { op: "summary" };
    default:
      return { op: "ask", question: "", keep: "yes" };
  }
}

class VzPipes extends HTMLElement {
  /** @type {any[]} */ pipes = [];
  /** @type {any[]} */ sources = [];
  /** @type {{ id: number | null, name: string, doc: any } | null} */ draft = null;
  /** @type {any} */ result = null;
  /** @type {number | null} */ opened = null;

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    root.innerHTML = `<style>${baseStyles}${STYLES}</style>
      <div class="wrap">
        <div class="head"><h2>Pipes</h2><button id="new" type="button" class="primary">New pipe</button></div>
        <p class="lede muted">A pipe reads feeds, runs steps on them, and gives you a new stream of items. It never changes the originals or what your rules hide.</p>
        <section id="editor" class="editor" hidden></section>
        <div id="status" role="status" class="muted"></div>
        <ul class="pipes" id="list"></ul>
      </div>`;
    this.$("new").addEventListener("click", () => this.edit(null));
  }

  /** @param {string} id */
  $(id) {
    return /** @type {HTMLElement} */ (/** @type {ShadowRoot} */ (this.shadowRoot).getElementById(id));
  }

  /** @param {string} text */
  say(text) {
    this.$("status").textContent = text;
  }

  async load() {
    try {
      const [{ pipes }, { sources }] = await Promise.all([api("/api/pipes"), api("/api/sources")]);
      this.pipes = pipes;
      this.sources = sources;
      this.renderList();
      if (!pipes.length && !this.draft) this.say("No pipes yet. A new pipe takes a few clicks: choose what it reads, then add the steps you want.");
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  folders() {
    return [...new Set(this.sources.map((s) => s.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  /** @param {any} input */
  describeInput(input) {
    if (input.kind === "all") return "everything";
    if (input.kind === "folder") return `the folder ${input.name}`;
    if (input.kind === "feed") return this.sources.find((s) => s.id === input.id)?.title || "a feed that is gone";
    return `the pipe ${this.pipes.find((p) => p.id === input.id)?.name ?? "that is gone"}`;
  }

  /** @param {any} c */
  describeCondition(c) {
    const field = FIELD_LABELS.find(([v]) => v === c.field)?.[1] ?? c.field;
    const test = TEST_LABELS.find(([v]) => v === c.test)?.[1] ?? c.test;
    return `the ${field} ${test} "${c.value}"`;
  }

  /** @param {any} s */
  describeStep(s) {
    switch (s.op) {
      case "filter":
        return `${s.keep ? "keeps" : "drops"} items where ${s.conditions.map((/** @type {any} */ c) => this.describeCondition(c)).join(s.match === "all" ? " and " : " or ")}`;
      case "newer-than":
        return `keeps the last ${s.days} days`;
      case "dedupe":
        return `removes repeats by ${s.by === "url" ? "link" : "headline"}`;
      case "sort":
        return `sorts by ${s.by === "date" ? "date" : s.by === "title" ? "title" : "feed"}, ${s.order === "desc" ? (s.by === "date" ? "newest first" : "Z to A") : s.by === "date" ? "oldest first" : "A to Z"}`;
      case "limit":
        return `keeps ${s.count}${s.perSource ? " per feed" : ""}`;
      case "rewrite":
        return `replaces "${s.find}" with "${s.replace}" in the ${s.field === "url" ? "link" : s.field}`;
      case "tag":
        return `tags items "${s.tag}"`;
      case "summary":
        return "uses the one-line summary as the text";
      default:
        return `keeps items the AI answers ${s.keep} to: "${s.question}"`;
    }
  }

  /** @param {any} doc */
  describe(doc) {
    const reads = doc.inputs.map((/** @type {any} */ i) => this.describeInput(i)).join(", ");
    const steps = doc.steps.map((/** @type {any} */ s) => this.describeStep(s));
    return `Reads ${reads}.${steps.length ? ` Then ${steps.join("; then ")}.` : ""} Shows up to ${doc.output.limit}.`;
  }

  renderList() {
    const list = this.$("list");
    list.replaceChildren(
      ...this.pipes.map((pipe) => {
        const title = el("h3", { text: pipe.name });
        if (pipe.tier === "private") title.append(el("span", { class: "badge", text: "private feeds", title: "It reads a private feed, so only local models read its text and it cannot be published." }));
        const row = el("div", { class: "row" });
        const li = el("li", { class: "pipe" }, title, el("p", { class: "meta", text: this.describe(pipe.doc) }));
        if (pipe.feedPath) li.append(el("p", { class: "meta" }, "Feed: ", el("a", { href: pipe.feedPath, target: "_blank", rel: "noopener", text: pipe.feedPath })));
        if (pipe.usedBy.length) li.append(el("p", { class: "meta", text: `Read by: ${pipe.usedBy.map((/** @type {number} */ id) => this.pipes.find((p) => p.id === id)?.name ?? id).join(", ")}` }));
        const show = el("div", { class: "out", hidden: this.opened !== pipe.id });
        row.append(
          el("button", { type: "button", text: this.opened === pipe.id ? "Hide items" : "Show items", onClick: () => this.toggleOpen(pipe) }),
          el("button", { type: "button", text: "Edit", onClick: () => this.edit(pipe) }),
          el("button", { type: "button", class: "quiet danger", text: "Delete", onClick: () => void this.deletePipe(pipe) }),
        );
        li.append(row, show);
        if (this.opened === pipe.id) void this.fill(pipe, show);
        return li;
      }),
    );
  }

  /** @param {any} pipe */
  toggleOpen(pipe) {
    this.opened = this.opened === pipe.id ? null : pipe.id;
    this.renderList();
  }

  /** @param {any} pipe @param {HTMLElement} show */
  async fill(pipe, show) {
    try {
      show.replaceChildren(this.renderResult(await api(`/api/pipes/${pipe.id}/items`)));
    } catch (error) {
      show.replaceChildren(el("p", { class: "muted", text: messageOf(error) }));
    }
  }

  /** @param {any} pipe */
  async deletePipe(pipe) {
    if (!confirm(`Delete the pipe "${pipe.name}"? The feeds it reads are not touched.`)) return;
    try {
      await api(`/api/pipes/${pipe.id}`, { method: "DELETE" });
      this.say(`Deleted "${pipe.name}".`);
      await this.load();
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  /** @param {any} result */
  renderResult(result) {
    const wrap = el("div");
    const counts = result.counts;
    wrap.append(el("p", { class: "meta", role: "status", text: `${counts.gathered} items read, ${counts.output} in the output${counts.waiting ? `, ${counts.waiting} waiting for the AI` : ""}.` }));
    for (const note of result.notes) wrap.append(el("p", { class: "notes", text: note }));
    const items = result.entries.slice(0, 40).map((/** @type {any} */ e) => {
      const link = /^https?:\/\//.test(e.url) ? el("a", { href: e.url, target: "_blank", rel: "noopener noreferrer", text: e.title || "(untitled)" }) : el("span", { text: e.title || "(untitled)" });
      const li = el("li", {}, link, el("div", { class: "meta", text: [e.source, e.publishedAt ? new Date(e.publishedAt).toLocaleDateString() : ""].filter(Boolean).join(" - ") }));
      for (const tag of e.tags) li.append(el("span", { class: "chip", text: tag }));
      return li;
    });
    wrap.append(items.length ? el("ol", {}, ...items) : el("p", { class: "muted", text: "Nothing comes out of this pipe right now." }));
    if (result.entries.length > 40) wrap.append(el("p", { class: "meta", text: `Showing the first 40 of ${result.entries.length}.` }));
    return wrap;
  }

  /** @param {any | null} pipe */
  edit(pipe) {
    this.draft = pipe ? { id: pipe.id, name: pipe.name, doc: JSON.parse(JSON.stringify(pipe.doc)) } : { id: null, name: "", doc: { version: 1, inputs: [{ kind: "all" }], steps: [], output: { limit: 100, publish: false } } };
    this.result = null;
    this.renderEditor();
    if (pipe) void this.preview();
    this.$("editor").scrollIntoView?.({ block: "nearest" });
  }

  close() {
    this.draft = null;
    this.result = null;
    const editor = this.$("editor");
    editor.hidden = true;
    editor.replaceChildren();
  }

  renderEditor() {
    const editor = this.$("editor");
    const draft = /** @type {NonNullable<VzPipes["draft"]>} */ (this.draft);
    editor.hidden = false;
    const doc = draft.doc;
    const redo = () => this.renderEditor();

    const name = textBox(draft.name, (v) => (draft.name = v), "Pipe name", "Name this pipe");
    const inputs = doc.inputs.map((/** @type {any} */ input, /** @type {number} */ index) => {
      const kind = choice(INPUT_KINDS, input.kind, (v) => {
        doc.inputs[index] = v === "all" ? { kind: "all" } : v === "folder" ? { kind: "folder", name: this.folders()[0] ?? "" } : v === "feed" ? { kind: "feed", id: this.sources[0]?.id ?? 0 } : { kind: "pipe", id: this.pipes.find((p) => p.id !== draft.id)?.id ?? 0 };
        redo();
      }, "What to read");
      const line = el("div", { class: "line" }, kind);
      if (input.kind === "folder") line.append(choice(this.folders().map((/** @type {string} */ f) => /** @type {[string, string]} */ ([f, f])), input.name, (v) => (input.name = v), "Folder"));
      if (input.kind === "feed") line.append(choice(this.sources.map((s) => /** @type {[string, string]} */ ([String(s.id), s.title || s.url])), String(input.id), (v) => (input.id = Number(v)), "Feed"));
      if (input.kind === "pipe") line.append(choice(this.pipes.filter((p) => p.id !== draft.id).map((p) => /** @type {[string, string]} */ ([String(p.id), p.name])), String(input.id), (v) => (input.id = Number(v)), "Pipe"));
      if (doc.inputs.length > 1) line.append(el("button", { type: "button", class: "quiet", text: "Remove", onClick: () => (doc.inputs.splice(index, 1), redo()) }));
      return line;
    });

    const steps = doc.steps.map((/** @type {any} */ step, /** @type {number} */ index) => this.stepCard(step, index, doc, redo));
    const adder = choice([["", "Add a step..."], ...Object.entries(STEP_LABELS)], "", () => {}, "Add a step");
    adder.addEventListener("change", () => {
      if (!adder.value) return;
      doc.steps.push(newStep(adder.value));
      redo();
    });

    const limit = numberBox(doc.output.limit, (v) => (doc.output.limit = v), "Items to show at most", 1, 500);
    const publish = checkBox(doc.output.publish, (v) => (doc.output.publish = v), "Also serve this as a feed on this computer");
    const feedNote = doc.output.publish ? el("p", { class: "meta", text: `It is served at ${draft.id ? this.pipes.find((p) => p.id === draft.id)?.feedPath || "an address shown after you save" : "an address shown after you save"}. Anyone who can reach this app can read it, and a pipe that reads a private feed cannot be published.` }) : null;

    const out = el("div", { class: "out" });
    if (this.result) out.append(this.renderResult(this.result));

    editor.replaceChildren(
      el("h3", { text: draft.id ? "Edit pipe" : "New pipe" }),
      el("label", { class: "field" }, el("span", { text: "Name" }), name),
      el("h4", { text: "Reads" }),
      ...inputs,
      el("div", { class: "line" }, el("button", { type: "button", class: "quiet", text: "Add another input", onClick: () => (doc.inputs.push({ kind: "all" }), redo()) })),
      el("h4", { text: "Then, in this order" }),
      ...steps,
      el("div", { class: "line" }, adder),
      el("h4", { text: "Output" }),
      el("div", { class: "line" }, el("span", { text: "Show up to" }), limit, el("span", { text: "items" })),
      el("div", { class: "line" }, publish),
      ...(feedNote ? [feedNote] : []),
      el("div", { class: "row" }, el("button", { type: "button", text: "Preview", onClick: () => void this.preview() }), el("button", { type: "button", class: "primary", text: "Save", onClick: () => void this.save() }), el("button", { type: "button", class: "quiet", text: "Cancel", onClick: () => this.close() })),
      out,
    );
  }

  /** @param {any} step @param {number} index @param {any} doc @param {() => void} redo */
  stepCard(step, index, doc, redo) {
    const move = (/** @type {number} */ by) => {
      const to = index + by;
      if (to < 0 || to >= doc.steps.length) return;
      [doc.steps[index], doc.steps[to]] = [doc.steps[to], doc.steps[index]];
      redo();
    };
    const top = el(
      "div",
      { class: "top" },
      el("strong", { text: `${index + 1}. ${STEP_LABELS[step.op] ?? step.op}` }),
      el("button", { type: "button", class: "quiet", text: "Up", "aria-label": "Move this step up", disabled: index === 0, onClick: () => move(-1) }),
      el("button", { type: "button", class: "quiet", text: "Down", "aria-label": "Move this step down", disabled: index === doc.steps.length - 1, onClick: () => move(1) }),
      el("button", { type: "button", class: "quiet danger", text: "Remove", onClick: () => (doc.steps.splice(index, 1), redo()) }),
    );
    const card = el("div", { class: "step" }, top);
    if (step.op === "filter") {
      card.append(
        el("div", { class: "line" }, choice([["keep", "Keep only items where"], ["drop", "Drop items where"]], step.keep ? "keep" : "drop", (v) => (step.keep = v === "keep"), "Keep or drop"), choice([["any", "any of these is true"], ["all", "all of these are true"]], step.match, (v) => (step.match = v), "Any or all")),
        ...step.conditions.map((/** @type {any} */ c, /** @type {number} */ ci) =>
          el(
            "div",
            { class: "line" },
            choice(FIELD_LABELS, c.field, (v) => (c.field = v), "Field"),
            choice(TEST_LABELS, c.test, (v) => (c.test = v), "Test"),
            textBox(c.value, (v) => (c.value = v), "Value", c.test === "regex" ? "a pattern, such as ^(AI|ML)" : "text"),
            step.conditions.length > 1 ? el("button", { type: "button", class: "quiet", text: "Remove", onClick: () => (step.conditions.splice(ci, 1), redo()) }) : null,
          ),
        ),
        el("div", { class: "line" }, el("button", { type: "button", class: "quiet", text: "Add a condition", onClick: () => (step.conditions.push({ field: "title", test: "contains", value: "" }), redo()) })),
      );
    } else if (step.op === "newer-than") {
      card.append(el("div", { class: "line" }, el("span", { text: "Keep items from the last" }), numberBox(step.days, (v) => (step.days = v), "Days", 1, 3650), el("span", { text: "days" })));
    } else if (step.op === "dedupe") {
      card.append(el("div", { class: "line" }, el("span", { text: "Keep the first of items with the same" }), choice([["url", "link"], ["title", "headline"]], step.by, (v) => (step.by = v), "Compare by")));
    } else if (step.op === "sort") {
      card.append(el("div", { class: "line" }, choice([["date", "Date"], ["title", "Title"], ["source", "Feed name"]], step.by, (v) => (step.by = v), "Sort by"), choice([["desc", "Newest or Z to A first"], ["asc", "Oldest or A to Z first"]], step.order, (v) => (step.order = v), "Order")));
    } else if (step.op === "limit") {
      card.append(el("div", { class: "line" }, el("span", { text: "Keep the first" }), numberBox(step.count, (v) => (step.count = v), "Count", 1, 500), checkBox(step.perSource, (v) => (step.perSource = v), "from each feed")));
    } else if (step.op === "rewrite") {
      card.append(
        el("div", { class: "line" }, el("span", { text: "In the" }), choice([["title", "title"], ["text", "text"], ["url", "link"], ["author", "author"]], step.field, (v) => (step.field = v), "Field")),
        el("div", { class: "line" }, textBox(step.find, (v) => (step.find = v), "Find", "find"), textBox(step.replace, (v) => (step.replace = v), "Replace with", "replace with (leave empty to remove)")),
        el("div", { class: "line" }, checkBox(step.regex, (v) => (step.regex = v), "The text to find is a pattern (use $1 for a group)")),
      );
    } else if (step.op === "tag") {
      card.append(el("div", { class: "line" }, textBox(step.tag, (v) => (step.tag = v), "Tag", "tag name")));
    } else if (step.op === "summary") {
      card.append(el("p", { class: "meta", text: "Items that have a one-line summary show it in place of their own text. No model is called here." }));
    } else if (step.op === "ask") {
      const question = /** @type {HTMLTextAreaElement} */ (el("textarea", { "aria-label": "The yes or no question", placeholder: "A question about one item, such as: Is this about a new AI model release?", value: step.question }));
      question.addEventListener("input", () => (step.question = question.value));
      card.append(
        question,
        el("div", { class: "line" }, choice([["yes", "Keep items answered yes"], ["no", "Keep items answered no"]], step.keep, (v) => (step.keep = v), "Which answers to keep")),
        el("p", { class: "meta", text: "The AI answers in the background, a few items a minute, and each answer is kept. Items not yet answered are held back, not dropped. Put cheap steps before this one so fewer items need asking. Text from a private feed only goes to local models." }),
      );
    }
    return card;
  }

  async preview() {
    const draft = this.draft;
    if (!draft) return;
    try {
      this.result = await api("/api/pipes/preview", { json: { doc: draft.doc, ...(draft.id ? { id: draft.id } : {}) } });
      this.renderEditor();
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  async save() {
    const draft = this.draft;
    if (!draft) return;
    try {
      const body = { name: draft.name, doc: draft.doc };
      const { pipe } = draft.id ? await api(`/api/pipes/${draft.id}`, { method: "PUT", json: body }) : await api("/api/pipes", { json: body });
      this.say(`Saved "${pipe.name}".`);
      this.close();
      await this.load();
    } catch (error) {
      this.say(messageOf(error));
    }
  }
}

customElements.define("vz-pipes", VzPipes);
