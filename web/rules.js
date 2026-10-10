// @ts-check
// The Rules screen: every rule as a sentence, an editor drawer with a live preview, and the list import panel.
import { api, baseStyles, effectsOn, el, messageOf } from "./ui.js";

const VERBS = { block: "Hide", pin: "Always show" };
const FIELD_LABEL = { title: "title", text: "text", author: "author", url: "link" };
const KIND_CHOICES = [
  ["block", "Hide"],
  ["weight+", "Favor"],
  ["weight-", "Demote"],
  ["pin", "Always show"],
];
const TYPE_CHOICES = [
  ["keyword", "Words"],
  ["regex", "Pattern"],
  ["semantic", "Meaning"],
  ["domain", "Domain"],
];

/** @param {string[]} fields */
function fieldsText(fields) {
  return fields.map((f) => FIELD_LABEL[/** @type {keyof typeof FIELD_LABEL} */ (f)] ?? f).join(" or ");
}

/** @param {string[]} values @param {number} max @returns {(Node | string)[]} */
function chips(values, max) {
  const out = /** @type {(Node | string)[]} */ (values.slice(0, max).map((v) => el("em", { class: "chip", text: v })));
  if (values.length > max) out.push(el("span", { class: "muted", text: ` and ${values.length - max} more` }));
  return out;
}

/** The rule as a sentence: verb, scope, then what it looks for. @param {any} rule @param {any[]} sources @returns {(Node | string)[]} */
export function sentence(rule, sources) {
  const parts = /** @type {(Node | string)[]} */ ([]);
  const verb = rule.kind === "weight" ? (rule.weight >= 0 ? "Favor" : "Demote") : VERBS[/** @type {keyof typeof VERBS} */ (rule.kind)];
  parts.push(`${verb} anything`);
  if (rule.scope.type === "folder") parts.push(" in ", el("em", { class: "chip", text: rule.scope.folder || "(no folder)" }));
  if (rule.scope.type === "source") {
    const source = sources.find((s) => s.id === rule.scope.sourceId);
    parts.push(" from ", el("em", { class: "chip", text: source ? source.title || source.url : "a removed feed" }));
  }
  const c = rule.condition;
  if (c.type === "keyword") parts.push(` whose ${fieldsText(c.fields)} ${c.mode === "all" ? "mentions all of" : "mentions"} `, ...chips(c.terms, 6));
  else if (c.type === "regex") parts.push(` whose ${fieldsText(c.fields)} matches `, el("em", { class: "chip", text: c.pattern }));
  else if (c.type === "semantic") parts.push(" that is about ", el("em", { class: "chip", text: c.sentence }), el("span", { class: "muted", text: ` (match at ${Math.round(c.threshold * 100)}%)` }));
  else if (c.type === "domain") parts.push(" linking to ", ...chips(c.domains, 4));
  return parts;
}

/** @param {any} rule */
function outcomeText(rule) {
  const bits = [];
  if (rule.matched) bits.push(rule.kind === "block" ? `Hid ${rule.matched}` : `Touched ${rule.matched}`);
  else bits.push("Nothing yet");
  if (rule.shadowMatched) bits.push(`${rule.shadowMatched} more when tried quietly`);
  if (rule.origin === "learned") bits.push("suggested by the AI");
  if (rule.origin === "learned" && rule.promotedAt && rule.status === "active") bits.push(`live since ${new Date(rule.promotedAt).toLocaleDateString()}, and 1 in 20 matches still shows as a check`);
  if (rule.origin === "learned" && rule.promotedAt && rule.meter?.votes) bits.push(`${rule.meter.votes} votes since, ${Math.round(rule.meter.rate * 100)}% agree`);
  if (rule.note) bits.push(rule.note);
  return bits.join(" - ");
}

/** The promotion meter of a rule being tried quietly: votes toward its bar, and how often the user's votes agree with it. @param {any} rule */
function meterView(rule) {
  const m = rule.meter;
  if (!m || rule.status !== "shadow") return null;
  const need = `${m.bar.votes} votes at ${Math.round(m.bar.agreement * 100)}% agreement`;
  const stricter = m.broad ? " (the stricter bar, because it matches a lot)" : "";
  const fill = el("div", { class: "fill" });
  fill.style.width = `${Math.round(Math.min(m.votes / m.bar.votes, 1) * 100)}%`;
  const track = el("div", { class: "track", role: "progressbar", "aria-label": "Votes toward going live", "aria-valuemin": "0", "aria-valuemax": String(m.bar.votes), "aria-valuenow": String(Math.min(m.votes, m.bar.votes)) }, fill);
  const text = m.votes === 0 ? `No votes yet on items it matches. It starts acting after ${need}${stricter}.` : `${m.votes} of ${m.bar.votes} votes so far, ${Math.round(m.rate * 100)}% agree. It starts acting after ${need}${stricter}.`;
  return el("div", { class: "meter" }, track, el("p", { class: "muted small", text }));
}

class VzRules extends HTMLElement {
  /** @type {any[]} */ rules = [];
  /** @type {any[]} */ sources = [];
  /** @type {any[]} */ proposals = [];
  /** @type {{ enabled: boolean, perDay: number } | null} */ learning = null;
  /** @type {any} */ preview = null;
  /** @type {Set<string>} */ unticked = new Set();
  /** @type {string | null} */ confirming = null;
  previewTimer = 0;
  previewSeq = 0;

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    root.innerHTML = `<style>${baseStyles}${STYLES}</style>
      <div class="wrap" id="wrap">
        <div class="head"><h2>Rules</h2><div class="actions"><button id="suggest" type="button">Suggest rules</button><button id="newRule" class="primary" type="button">New rule</button><button id="importOpen" type="button" aria-expanded="false">Import a list</button></div></div>
        <p class="lede muted">Each rule is a sentence you can read back. Hide rules always win; the count shows what each one has done.</p>
        <div id="status" role="status" class="muted"></div>
        <section id="suggested" class="suggested" aria-labelledby="sugHead" hidden></section>
        <section id="importPanel" hidden></section>
        <ol id="list" class="rules"></ol>
        <section id="learning" class="learning" hidden></section>
        <div id="scrim" class="scrim" hidden></div>
        <aside id="drawer" class="drawer" role="dialog" aria-modal="true" aria-label="Rule editor" hidden></aside>
      </div>`;
    root.getElementById("wrap")?.classList.toggle("fx", effectsOn());
    root.getElementById("newRule")?.addEventListener("click", () => this.edit(null));
    root.getElementById("suggest")?.addEventListener("click", () => this.suggest());
    root.getElementById("importOpen")?.addEventListener("click", () => this.toggleImport());
    root.getElementById("scrim")?.addEventListener("click", () => this.closeDrawer());
    root.addEventListener("keydown", (e) => {
      if (/** @type {KeyboardEvent} */ (e).key === "Escape") this.closeDrawer();
    });
    this.load();
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
      const [{ rules }, { sources }, found, learning] = await Promise.all([api("/api/rules"), api("/api/sources"), api("/api/proposals").catch(() => ({ proposals: [] })), api("/api/settings/learning").catch(() => null)]);
      this.rules = rules;
      this.sources = sources;
      this.proposals = found.proposals;
      this.learning = learning;
      this.renderSuggested();
      this.renderList();
      this.renderLearning();
      this.say(rules.length || this.proposals.length ? "" : "No rules yet. Make one with New rule, or import a list of words or domains.");
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  renderList() {
    const list = this.$("list");
    list.replaceChildren(
      ...this.rules.map((rule) => {
        const on = rule.status === "active";
        const toggle = el("button", {
          class: "switch",
          type: "button",
          role: "switch",
          "aria-checked": String(on),
          "aria-label": on ? "Turn this rule off" : "Turn this rule on",
          title: rule.status === "shadow" ? "Being tried quietly: it counts matches but changes nothing. Turn on to make it act." : on ? "On" : "Off",
          onClick: () => this.patch(rule.id, { status: on ? "disabled" : "active" }),
        });
        const confirming = this.confirming === String(rule.id);
        return el(
          "li",
          { class: `rule ${rule.status}` },
          el("div", { class: "body" }, el("p", { class: "sentence" }, ...sentence(rule, this.sources)), el("p", { class: "meta muted", text: `${rule.status === "shadow" ? "Trying quietly. " : rule.status === "disabled" ? "Off. " : ""}${outcomeText(rule)}` }), meterView(rule)),
          el(
            "div",
            { class: "controls" },
            rule.status === "shadow" && rule.origin === "learned" ? el("button", { type: "button", text: "Make it live now", title: "Skip the wait: it starts acting at once, with 1 in 20 matches still shown as a check.", onClick: () => this.promote(rule.id) }) : null,
            toggle,
            el("button", { class: "quiet", type: "button", onClick: () => this.edit(rule), text: "Edit" }),
            el("button", {
              class: `quiet danger`,
              type: "button",
              text: confirming ? "Really delete?" : "Delete",
              onClick: () => (confirming ? this.deleteRule(rule.id) : this.confirmDelete(rule.id)),
            }),
          ),
        );
      }),
    );
  }

  /** @param {number} id */
  async promote(id) {
    try {
      await api(`/api/rules/${id}/promote`, { method: "POST" });
      await this.load();
      this.say("It is live now. One match in twenty still shows, so you can check it.");
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  /* ---------- suggestions ---------- */

  async suggest() {
    const button = /** @type {HTMLButtonElement} */ (this.$("suggest"));
    button.disabled = true;
    this.say("Looking through your votes...");
    try {
      const { run } = await api("/api/proposals/run", { method: "POST" });
      await this.load();
      this.say(run.queued ? "The model is busy right now. Try again in a little while." : run.proposed ? `Found ${run.proposed} new ${run.proposed === 1 ? "suggestion" : "suggestions"}.` : run.drafted ? "Nothing held up when checked against your votes. More votes will help." : "Nothing new yet. A suggestion needs at least 3 similar votes you have not already used.");
    } catch (error) {
      this.say(messageOf(error));
    } finally {
      button.disabled = false;
    }
  }

  renderSuggested() {
    const box = this.$("suggested");
    box.hidden = !this.proposals.length;
    if (!this.proposals.length) {
      box.replaceChildren();
      return;
    }
    box.replaceChildren(
      el("h3", { id: "sugHead", text: "Suggested" }),
      el("p", { class: "muted small", text: "Drafted from your votes. Nothing here is on until you accept it, and an accepted rule starts out quietly counting matches." }),
      el("ol", { class: "rules" }, ...this.proposals.map((p) => this.proposalRow(p))),
    );
  }

  /** @param {any} p */
  proposalRow(p) {
    const shown = /** @type {any[]} */ (p.evidenceItems);
    const evidence = el(
      "details",
      { class: "evidence" },
      el("summary", { text: `Based on ${p.evidenceCount} ${p.evidenceCount === 1 ? "vote" : "votes"}` }),
      el("ul", {}, ...shown.map((e) => el("li", {}, el("span", { class: "vote", text: e.vote > 0 ? "Liked" : "Disliked" }), ` ${e.title || "(untitled)"}`, e.reason ? el("span", { class: "muted", text: ` - "${e.reason}"` }) : null))),
      p.evidenceCount > shown.length ? el("p", { class: "muted small", text: `and ${p.evidenceCount - shown.length} more` }) : null,
    );
    return el(
      "li",
      { class: "rule suggestion" },
      el("div", { class: "body" }, el("p", { class: "sentence" }, ...sentence(p, this.sources)), el("p", { class: "meta muted", text: p.rationale }), evidence),
      el(
        "div",
        { class: "controls" },
        el("button", { type: "button", class: "primary", text: "Accept", onClick: () => this.decide(p, "accept") }),
        el("button", { type: "button", class: "quiet", text: "Edit", onClick: () => this.edit(null, p) }),
        el("button", { type: "button", class: "quiet", text: "Not this", onClick: () => this.decide(p, "reject") }),
      ),
    );
  }

  /** @param {any} p @param {"accept" | "reject"} action */
  async decide(p, action) {
    try {
      await api(`/api/proposals/${p.id}/${action}`, { json: {} });
      await this.load();
      this.say(action === "accept" ? "Accepted. It is counting matches quietly and will start acting once enough of your votes agree with it." : "Dropped. It will not be suggested again.");
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  renderLearning() {
    const box = this.$("learning");
    const settings = this.learning;
    box.hidden = !settings;
    if (!settings) return;
    const toggle = el("button", {
      class: "switch",
      type: "button",
      role: "switch",
      "aria-checked": String(settings.enabled),
      "aria-label": "Ask me about borderline items in Reading",
      onClick: () => this.saveLearning({ enabled: !settings.enabled }),
    });
    const perDay = /** @type {HTMLSelectElement} */ (el("select", { "aria-label": "Questions a day" }, ...[1, 2, 3, 5, 10].map((n) => el("option", { value: String(n), text: String(n), selected: n === settings.perDay }))));
    perDay.addEventListener("change", () => this.saveLearning({ perDay: Number(perDay.value) }));
    box.replaceChildren(
      el("h3", { text: "Learning" }),
      el("div", { class: "learning-row" }, toggle, el("span", { text: "Now and then, ask me about an item the AI is unsure of" }), el("label", { class: "muted small" }, "At most ", perDay, " a day")),
      el("p", { class: "muted small", text: "The question shows at the top of Reading with Like, Dislike and an optional reason. Your answer teaches the model the most when it is unsure." }),
    );
  }

  /** @param {Record<string, unknown>} change */
  async saveLearning(change) {
    try {
      await api("/api/settings/learning", { method: "PUT", json: change });
      await this.load();
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  /** @param {number} id */
  confirmDelete(id) {
    this.confirming = String(id);
    this.renderList();
    setTimeout(() => {
      if (this.confirming === String(id)) {
        this.confirming = null;
        this.renderList();
      }
    }, 4000);
  }

  /** @param {number} id */
  async deleteRule(id) {
    this.confirming = null;
    try {
      await api(`/api/rules/${id}`, { method: "DELETE" });
      await this.load();
      this.say("Rule deleted. Anything it hid has come back.");
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  /** @param {number} id @param {Record<string, unknown>} change */
  async patch(id, change) {
    try {
      await api(`/api/rules/${id}`, { method: "PATCH", json: change });
      await this.load();
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  /* ---------- editor ---------- */

  /** @param {any | null} rule @param {any | null} [proposal] a suggestion being edited before it is accepted */
  edit(rule, proposal = null) {
    const drawer = this.$("drawer");
    const draft = proposal
      ? { kind: proposal.kind, weight: proposal.weight, status: "shadow", scope: structuredClone(proposal.scope), note: proposal.rationale, condition: structuredClone(proposal.condition) }
      : rule
      ? structuredClone(rule)
      : { kind: "block", weight: 0.5, status: "active", scope: { type: "all" }, note: "", condition: { type: "keyword", terms: [], mode: "any", fields: ["title", "text"] } };
    const c = draft.condition;
    const kindValue = draft.kind === "weight" ? (draft.weight >= 0 ? "weight+" : "weight-") : draft.kind;

    const kind = /** @type {HTMLSelectElement} */ (el("select", { id: "f-kind" }, ...KIND_CHOICES.map(([v, t]) => el("option", { value: v, text: t, selected: v === kindValue }))));
    const strength = /** @type {HTMLInputElement} */ (el("input", { type: "range", id: "f-strength", min: "0.1", max: "1", step: "0.1", value: String(Math.abs(draft.weight) || 0.5) }));
    const strengthLabel = el("span", { class: "muted" });
    const type = /** @type {HTMLSelectElement} */ (el("select", { id: "f-type" }, ...TYPE_CHOICES.map(([v, t]) => el("option", { value: v, text: t, selected: v === c.type }))));

    const terms = /** @type {HTMLTextAreaElement} */ (el("textarea", { id: "f-terms", rows: 4, placeholder: "One word or phrase per line", value: (c.terms ?? []).join("\n") }));
    const mode = /** @type {HTMLSelectElement} */ (el("select", { id: "f-mode" }, el("option", { value: "any", text: "any of the words", selected: c.mode !== "all" }), el("option", { value: "all", text: "all of the words", selected: c.mode === "all" })));
    const pattern = /** @type {HTMLInputElement} */ (el("input", { type: "text", id: "f-pattern", placeholder: "A regular expression", value: c.pattern ?? "" }));
    const sentenceInput = /** @type {HTMLInputElement} */ (el("input", { type: "text", id: "f-sentence", placeholder: "For example: celebrity gossip", value: c.sentence ?? "" }));
    const examples = /** @type {HTMLTextAreaElement} */ (el("textarea", { id: "f-examples", rows: 3, placeholder: "Optional: titles that should match, one per line", value: (c.examples ?? []).join("\n") }));
    const counter = /** @type {HTMLTextAreaElement} */ (el("textarea", { id: "f-counter", rows: 3, placeholder: "Optional: titles that look similar but should not match", value: (c.counterExamples ?? []).join("\n") }));
    const threshold = /** @type {HTMLInputElement} */ (el("input", { type: "range", id: "f-threshold", min: "0.3", max: "0.95", step: "0.01", value: String(c.threshold ?? 0.6) }));
    const thresholdLabel = el("span", { class: "muted" });
    const domains = /** @type {HTMLTextAreaElement} */ (el("textarea", { id: "f-domains", rows: 4, placeholder: "One domain per line, like example.com", value: (c.domains ?? []).join("\n") }));
    const makeBoxes = () => ["title", "text", "author", "url"].map((f) => el("label", { class: "check" }, el("input", { type: "checkbox", value: f, checked: (c.fields ?? ["title", "text"]).includes(f) }), ` ${FIELD_LABEL[/** @type {keyof typeof FIELD_LABEL} */ (f)]}`));

    const scope = /** @type {HTMLSelectElement} */ (el("select", { id: "f-scope" }, el("option", { value: "all", text: "Everywhere" }), el("option", { value: "folder", text: "One folder" }), el("option", { value: "source", text: "One feed" })));
    const scopeValue = /** @type {HTMLSelectElement} */ (el("select", { id: "f-scope-value", "aria-label": "Which one" }));
    const folders = [...new Set(this.sources.map((s) => s.folder))].sort();
    const fillScope = () => {
      scopeValue.hidden = scope.value === "all";
      if (scope.value === "folder") scopeValue.replaceChildren(...folders.map((f) => el("option", { value: f, text: f || "(no folder)", selected: draft.scope.type === "folder" && draft.scope.folder === f })));
      if (scope.value === "source") scopeValue.replaceChildren(...this.sources.map((s) => el("option", { value: String(s.id), text: s.title || s.url, selected: draft.scope.type === "source" && draft.scope.sourceId === s.id })));
    };
    scope.value = draft.scope.type;
    fillScope();
    scope.addEventListener("change", () => {
      draft.scope = { type: "all" };
      fillScope();
      schedulePreview();
    });

    const quiet = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox", id: "f-shadow", checked: draft.status === "shadow", disabled: !!proposal }));
    const note = /** @type {HTMLInputElement} */ (el("input", { type: "text", id: "f-note", maxLength: 300, value: draft.note ?? "", placeholder: "Optional: why this rule exists" }));
    const previewBox = el("div", { class: "preview", "aria-live": "polite" });
    const error = el("p", { class: "error", role: "alert" });

    const groupWords = el("div", { class: "group" }, el("label", { class: "field" }, el("span", { text: "Words and phrases" }), terms), el("label", { class: "field" }, el("span", { text: "Matches" }), mode), el("div", { class: "field" }, el("span", { class: "legend", text: "Look in" }), el("div", { class: "checks" }, ...makeBoxes())));
    const groupPattern = el("div", { class: "group" }, el("label", { class: "field" }, el("span", { text: "Pattern" }), pattern), el("div", { class: "field" }, el("span", { class: "legend", text: "Look in" }), el("div", { class: "checks" }, ...makeBoxes())));
    const groupMeaning = el(
      "div",
      { class: "group" },
      el("label", { class: "field" }, el("span", { text: "What it is about" }), sentenceInput),
      el("label", { class: "field" }, el("span", { text: "Examples that match" }), examples),
      el("label", { class: "field" }, el("span", { text: "Look-alikes that should not match" }), counter),
      el("label", { class: "field" }, el("span", { text: "How close a match has to be" }), threshold, thresholdLabel),
    );
    const groupDomain = el("div", { class: "group" }, el("label", { class: "field" }, el("span", { text: "Domains" }), domains), el("p", { class: "muted small", text: "Matches the domain and its subdomains, judged by each item's link." }));
    const groups = { keyword: groupWords, regex: groupPattern, semantic: groupMeaning, domain: groupDomain };

    const clean = (/** @type {string} */ text) => text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const fieldsOf = (/** @type {HTMLElement} */ group) => [...group.querySelectorAll("input[type=checkbox]")].filter((b) => /** @type {HTMLInputElement} */ (b).checked).map((b) => /** @type {HTMLInputElement} */ (b).value);
    const readCondition = () => {
      if (type.value === "keyword") return { type: "keyword", terms: clean(terms.value), mode: mode.value, fields: fieldsOf(groupWords) };
      if (type.value === "regex") return { type: "regex", pattern: pattern.value, flags: "i", fields: fieldsOf(groupPattern) };
      if (type.value === "semantic") return { type: "semantic", sentence: sentenceInput.value.trim(), examples: clean(examples.value), counterExamples: clean(counter.value), threshold: Number(threshold.value) };
      return { type: "domain", domains: clean(domains.value) };
    };
    const readScope = () => (scope.value === "folder" ? { type: "folder", folder: scopeValue.value } : scope.value === "source" ? { type: "source", sourceId: Number(scopeValue.value) } : { type: "all" });

    const sync = () => {
      for (const [name, group] of Object.entries(groups)) group.hidden = name !== type.value;
      strength.parentElement && (strength.parentElement.hidden = !kind.value.startsWith("weight"));
      strengthLabel.textContent = `${Math.round(Number(strength.value) * 100)}% push`;
      thresholdLabel.textContent = `Matches at ${Math.round(Number(threshold.value) * 100)}% similarity or higher. Slide it and watch the preview.`;
    };

    const runPreview = async () => {
      const seq = ++this.previewSeq;
      error.textContent = "";
      try {
        const result = await api("/api/rules/preview", { json: { condition: readCondition() } });
        if (seq !== this.previewSeq) return;
        const matched = /** @type {any[]} */ (result.rows).filter((r) => r.matched);
        previewBox.replaceChildren(
          el("p", { class: "count", text: `Would match ${result.matched} of the newest ${result.total} items.` }),
          ...(matched.length
            ? [el("ul", {}, ...matched.slice(0, 8).map((r) => el("li", { text: r.similarity === null ? r.title : `${r.title} (${Math.round(r.similarity * 100)}%)` })))]
            : type.value === "semantic" && !result.rows.some((/** @type {any} */ r) => r.similarity !== null)
              ? [el("p", { class: "muted small", text: "A meaning rule needs the embedding model, and it is not reachable right now, so there is nothing to preview." })]
              : type.value === "semantic" && result.rows.length
              ? [el("p", { class: "muted small", text: "Closest items so far:" }), el("ul", {}, ...result.rows.slice(0, 5).map((/** @type {any} */ r) => el("li", { text: r.similarity === null ? r.title : `${r.title} (${Math.round(r.similarity * 100)}%)` })))]
              : []),
        );
      } catch (e) {
        if (seq === this.previewSeq) previewBox.replaceChildren(el("p", { class: "muted small", text: messageOf(e) }));
      }
    };
    const schedulePreview = () => {
      clearTimeout(this.previewTimer);
      this.previewTimer = /** @type {any} */ (setTimeout(runPreview, 350));
    };

    drawer.replaceChildren(
      el("div", { class: "drawer-head" }, el("h3", { text: proposal ? "Edit suggestion" : rule ? "Edit rule" : "New rule" }), el("button", { class: "quiet", type: "button", "aria-label": "Close the editor", text: "Close", onClick: () => this.closeDrawer() })),
      el(
        "form",
        {
          onSubmit: async (/** @type {Event} */ event) => {
            event.preventDefault();
            const weight = kind.value.startsWith("weight") ? (kind.value === "weight-" ? -1 : 1) * Number(strength.value) : 0;
            const status = quiet.checked ? "shadow" : rule && rule.status === "disabled" ? "disabled" : "active";
            const body = { kind: kind.value.startsWith("weight") ? "weight" : kind.value, weight, scope: readScope(), condition: readCondition(), status, note: note.value };
            try {
              await api(proposal ? `/api/proposals/${proposal.id}/accept` : rule ? `/api/rules/${rule.id}` : "/api/rules", { method: rule ? "PATCH" : "POST", json: body });
              this.closeDrawer();
              await this.load();
              this.say(proposal ? "Accepted with your changes. It is counting matches quietly until enough of your votes agree with it." : rule ? "Rule saved." : "Rule added and applied.");
            } catch (e) {
              error.textContent = messageOf(e);
            }
          },
        },
        el("label", { class: "field" }, el("span", { text: "What it does" }), kind),
        el("label", { class: "field strength" }, el("span", { text: "How hard it pushes" }), strength, strengthLabel),
        el("label", { class: "field" }, el("span", { text: "What it looks for" }), type),
        groupWords,
        groupPattern,
        groupMeaning,
        groupDomain,
        el("div", { class: "field" }, el("span", { class: "legend", text: "Where it applies" }), el("div", { class: "scope" }, scope, scopeValue)),
        el("label", { class: "check" }, quiet, proposal ? " Starts quietly: it counts matches and changes nothing until enough of your votes agree" : " Try it quietly first: count matches without changing anything"),
        el("label", { class: "field" }, el("span", { text: "Note" }), note),
        el("div", { class: "field" }, el("span", { class: "legend", text: "Preview" }), previewBox),
        error,
        el("div", { class: "drawer-foot" }, el("button", { class: "primary", type: "submit", text: proposal ? "Accept suggestion" : rule ? "Save rule" : "Add rule" }), el("button", { type: "button", text: "Cancel", onClick: () => this.closeDrawer() })),
      ),
    );
    type.addEventListener("change", () => {
      sync();
      schedulePreview();
    });
    kind.addEventListener("change", sync);
    strength.addEventListener("input", sync);
    threshold.addEventListener("input", () => {
      sync();
      schedulePreview();
    });
    for (const input of [terms, mode, pattern, sentenceInput, examples, counter, domains]) input.addEventListener("input", schedulePreview);
    drawer.addEventListener("change", (e) => {
      if (/** @type {HTMLElement} */ (e.target).matches("input[type=checkbox]") && !(/** @type {HTMLElement} */ (e.target).id === "f-shadow")) schedulePreview();
    });
    sync();
    this.$("scrim").hidden = false;
    drawer.hidden = false;
    requestAnimationFrame(() => drawer.classList.add("open"));
    if (rule || proposal) runPreview();
  }

  closeDrawer() {
    const drawer = this.$("drawer");
    drawer.classList.remove("open");
    drawer.hidden = true;
    this.$("scrim").hidden = true;
  }

  /* ---------- import ---------- */

  toggleImport() {
    const panel = this.$("importPanel");
    const open = panel.hidden;
    panel.hidden = !open;
    this.$("importOpen").setAttribute("aria-expanded", String(open));
    if (open) this.renderImport();
  }

  renderImport() {
    const panel = this.$("importPanel");
    this.preview = null;
    this.unticked = new Set();
    const format = /** @type {HTMLSelectElement} */ (el("select", { id: "i-format" }, el("option", { value: "words", text: "Words and phrases" }), el("option", { value: "domains", text: "Domains" })));
    const text = /** @type {HTMLTextAreaElement} */ (el("textarea", { id: "i-text", rows: 7, placeholder: "Paste a list here, one entry per line" }));
    const file = /** @type {HTMLInputElement} */ (el("input", { type: "file", id: "i-file", accept: ".txt,.list,.csv,text/plain" }));
    const name = /** @type {HTMLInputElement} */ (el("input", { type: "text", id: "i-name", maxLength: 80, placeholder: "A name for the list, like Crypto spam" }));
    const group = /** @type {HTMLSelectElement} */ (el("select", { id: "i-group" }, el("option", { value: "list", text: "One rule holding the whole list" }), el("option", { value: "each", text: "One rule per line (up to 500 lines)" })));
    const scope = /** @type {HTMLSelectElement} */ (el("select", { id: "i-scope" }, el("option", { value: "all", text: "Everywhere" }), ...[...new Set(this.sources.map((s) => s.folder))].filter(Boolean).sort().map((f) => el("option", { value: `folder:${f}`, text: `Folder: ${f}` }))));
    const boxes = ["title", "text", "author"].map((f) => el("label", { class: "check" }, el("input", { type: "checkbox", value: f, checked: f !== "author" }), ` ${f}`));
    const fieldsRow = el("div", { class: "field" }, el("span", { class: "legend", text: "Look in" }), el("div", { class: "checks" }, ...boxes));
    const result = el("div", { id: "i-result", "aria-live": "polite" });
    const note = el("p", { class: "muted small" });

    const body = () => ({
      format: format.value,
      text: text.value,
      name: name.value,
      group: group.value,
      scope: scope.value.startsWith("folder:") ? { type: "folder", folder: scope.value.slice(7) } : { type: "all" },
      fields: boxes.map((b) => /** @type {HTMLInputElement} */ (b.querySelector("input"))).filter((b) => b.checked).map((b) => b.value),
    });
    const stale = () => {
      this.preview = null;
      result.replaceChildren();
    };
    const sync = () => {
      fieldsRow.hidden = format.value !== "words";
      note.textContent = format.value === "words" ? "Plain words and phrases, one per line. Lines starting with # and a space are comments. Matching ignores case." : "Bare domains, hosts-file lines (0.0.0.0 example.com), ||example.com^ lines and full links all work. A domain also covers its subdomains.";
    };
    format.addEventListener("change", () => {
      sync();
      stale();
    });
    for (const input of [text, name, group, scope]) input.addEventListener("input", stale);
    for (const b of boxes) b.addEventListener("change", stale);
    file.addEventListener("change", async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      if (chosen.size > 4 * 1024 * 1024) {
        result.replaceChildren(el("p", { class: "error", text: "That file is over 4 MB, which is more than a list needs." }));
        return;
      }
      text.value = await chosen.text();
      if (!name.value) name.value = chosen.name.replace(/\.[^.]+$/, "");
      stale();
    });

    const previewButton = el("button", {
      type: "button",
      class: "primary",
      text: "Preview",
      onClick: async () => {
        result.replaceChildren(el("p", { class: "muted", text: "Reading the list..." }));
        try {
          this.preview = await api("/api/rules/import/preview", { json: body() });
          this.unticked = new Set();
          this.renderPreview(result, body, () => this.renderImport());
        } catch (e) {
          this.preview = null;
          result.replaceChildren(el("p", { class: "error", text: messageOf(e) }));
        }
      },
    });
    panel.replaceChildren(
      el(
        "div",
        { class: "import" },
        el("h3", { text: "Import a list" }),
        el("label", { class: "field" }, el("span", { text: "What the list holds" }), format),
        el("label", { class: "field" }, el("span", { text: "List" }), text),
        el("label", { class: "field" }, el("span", { text: "Or choose a file" }), file),
        note,
        el("label", { class: "field" }, el("span", { text: "Name" }), name),
        el("label", { class: "field" }, el("span", { text: "Made into" }), group),
        el("label", { class: "field" }, el("span", { text: "Where it applies" }), scope),
        fieldsRow,
        el("div", { class: "row" }, previewButton, el("button", { type: "button", text: "Close", onClick: () => this.toggleImport() })),
        result,
      ),
    );
    sync();
  }

  /** @param {HTMLElement} result @param {() => Record<string, any>} body @param {() => void} reset */
  renderPreview(result, body, reset) {
    const p = this.preview;
    const matching = /** @type {any[]} */ (p.matching);
    const importButton = el("button", { type: "button", class: "primary" });
    const refresh = () => {
      const count = p.entryCount - p.alreadyCovered.length - [...this.unticked].filter((e) => !p.alreadyCovered.includes(e)).length;
      importButton.textContent = count > 0 ? `Import ${count} ${count === 1 ? "entry" : "entries"} and apply now` : "Nothing left to import";
      /** @type {HTMLButtonElement} */ (importButton).disabled = count <= 0;
    };
    importButton.addEventListener("click", async () => {
      /** @type {HTMLButtonElement} */ (importButton).disabled = true;
      try {
        const done = await api("/api/rules/import", { json: { ...body(), exclude: [...this.unticked] } });
        reset();
        await this.load();
        this.say(done.created ? `Imported ${done.imported} entries as ${done.created} ${done.created === 1 ? "rule" : "rules"}. They are working now, and anything they hid is under Filtered out.` : "Nothing new: every entry was already covered by a rule.");
      } catch (e) {
        result.append(el("p", { class: "error", text: messageOf(e) }));
        refresh();
      }
    });
    const rows = matching.map((m) => {
      const box = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox", checked: true }));
      box.addEventListener("change", () => {
        if (box.checked) this.unticked.delete(m.entry);
        else this.unticked.add(m.entry);
        refresh();
      });
      return el("li", {}, el("label", { class: "check" }, box, el("span", { class: "chip", text: m.entry }), el("span", { class: "muted small", text: ` hides ${m.matched}${m.titles?.length ? `, such as "${m.titles[0]}"` : ""}` })));
    });
    result.replaceChildren(
      el("p", { class: "count", text: `${p.entryCount} ${p.entryCount === 1 ? "entry" : "entries"} read. Together they would hide ${p.wouldHide} of the newest ${p.total} items.` }),
      ...(rows.length ? [el("p", { class: "muted small", text: `These entries match something now. Untick any you want to leave out${p.matchingCount > matching.length ? ` (showing the first ${matching.length} of ${p.matchingCount})` : ""}.` }), el("ul", { class: "entries" }, ...rows)] : [el("p", { class: "muted", text: "None of the entries match the newest items, so nothing would be hidden right now. They are still added and will catch future items." })]),
      ...(p.unmatchedCount ? [el("p", { class: "muted small", text: `${p.unmatchedCount} more ${p.unmatchedCount === 1 ? "entry matches" : "entries match"} nothing yet and will be added to catch future items.` })] : []),
      ...(p.alreadyCovered.length ? [el("p", { class: "muted small", text: `${p.alreadyCovered.length} already covered by an existing Hide rule, so they are skipped.` })] : []),
      ...(p.skippedCount ? [el("details", {}, el("summary", { text: `${p.skippedCount} ${p.skippedCount === 1 ? "line was" : "lines were"} not usable` }), el("ul", { class: "skipped" }, ...p.skipped.map((/** @type {any} */ s) => el("li", { class: "muted small", text: `Line ${s.line}: ${s.text} (${s.reason})` }))))] : []),
      el("div", { class: "row" }, importButton),
    );
    refresh();
  }
}

const STYLES = `
  .wrap { position: relative; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h2 { font-family: var(--font-display); font-style: italic; font-weight: 700; font-size: 34px; margin: 0; color: var(--text-strong); }
  h3 { font-family: var(--font-display); font-style: italic; font-weight: 700; font-size: 26px; margin: 0 0 10px; color: var(--text-strong); }
  .actions, .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0; }
  .lede { margin: 4px 0 6px; }
  #status { min-height: 24px; font-size: 15px; }
  .small { font-size: 15px; }
  ol.rules { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 12px; }
  .rule { display: flex; gap: 14px; align-items: flex-start; justify-content: space-between; background: var(--bg-raised); border: 1px solid var(--line); border-radius: 6px; padding: 14px 18px; }
  .rule.disabled { border-style: dashed; background: transparent; }
  .rule.shadow { border-style: dashed; }
  .fx .rule { transition: border-color .2s ease, transform .2s ease; }
  .fx .rule:hover { border-color: var(--accent-dim); }
  .body { min-width: 0; flex: 1 1 auto; }
  .sentence { font-family: var(--font-display); font-size: 23px; line-height: 1.3; margin: 0; color: var(--text-strong); overflow-wrap: anywhere; }
  .meta { margin: 6px 0 0; font-size: 15px; }
  .controls { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 2px; flex: none; }
  .suggested { border: 1px solid var(--accent-dim); border-left: 4px solid var(--accent); border-radius: 6px; padding: 14px 18px 16px; margin-top: 14px; background: var(--bg-raised); }
  .suggested h3 { margin: 0 0 4px; color: var(--accent); }
  .suggested p.muted { margin: 0; }
  .suggested ol.rules { margin-top: 12px; }
  .suggested .rule { background: var(--bg); }
  .evidence { margin-top: 8px; font-size: 15px; }
  .evidence summary { cursor: pointer; color: var(--muted); min-height: 32px; display: flex; align-items: center; }
  .evidence ul { list-style: none; margin: 6px 0; padding: 0; display: grid; gap: 4px; }
  .vote { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line-strong); border-radius: 999px; padding: 0 7px; }
  .meter { margin-top: 8px; }
  .meter p { margin: 4px 0 0; }
  .track { height: 6px; border-radius: 3px; background: var(--bg); border: 1px solid var(--line-strong); overflow: hidden; }
  .fill { height: 100%; background: var(--accent); }
  .fx .fill { transition: width .4s ease; }
  .learning { margin-top: 30px; border-top: 1px solid var(--line); padding-top: 12px; }
  .learning h3 { font-size: 22px; margin-bottom: 4px; }
  .learning-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .learning select { width: auto; min-width: 72px; }
  section#importPanel { margin-top: 12px; }
  .import { background: var(--bg-raised); border: 1px solid var(--line-strong); border-radius: 6px; padding: 18px 20px; }
  .check { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; }
  .check input { width: 18px; height: 18px; accent-color: var(--accent); }
  .checks { display: flex; gap: 14px; flex-wrap: wrap; }
  .field { margin-bottom: 14px; }
  div.field { display: grid; gap: 6px; }
  .count { margin: 12px 0 6px; color: var(--text-strong); font-weight: 500; }
  ul.entries, ul.skipped, .preview ul { list-style: none; margin: 6px 0; padding: 0; display: grid; gap: 2px; max-height: 280px; overflow: auto; }
  .preview li { font-size: 15px; overflow-wrap: anywhere; }
  .error { color: var(--down); margin: 8px 0; min-height: 0; }
  .scope { display: grid; gap: 8px; }
  .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, .55); z-index: 20; }
  .drawer { position: fixed; z-index: 21; top: 0; right: 0; bottom: 0; width: min(480px, 100vw); overflow: auto; background: var(--bg); border-left: 1px solid var(--line-strong); padding: 20px 22px 28px; }
  .fx .drawer { transform: translateX(24px); opacity: 0; transition: transform .22s ease, opacity .22s ease; }
  .fx .drawer.open { transform: none; opacity: 1; }
  .drawer-head { display: flex; justify-content: space-between; align-items: center; }
  .drawer-foot { display: flex; gap: 10px; position: sticky; bottom: -28px; padding: 12px 0; background: var(--bg); }
  @media (max-width: 640px) {
    .rule { flex-direction: column; }
    .controls { justify-content: flex-start; }
    .sentence { font-size: 21px; }
    .drawer { top: auto; width: 100vw; max-height: 92vh; border-left: 0; border-top: 1px solid var(--line-strong); border-radius: 14px 14px 0 0; }
    .fx .drawer { transform: translateY(24px); }
    .actions button { flex: 1 1 auto; }
  }
`;

customElements.define("vz-rules", VzRules);
