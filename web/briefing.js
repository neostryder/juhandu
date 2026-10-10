// @ts-check
// The home screen: the newest briefing, one section per folder, with a way to build a fresh one and to mark it read.
// Every line is shown as text, never as markup.
import { api, baseStyles, el, messageOf, voteControls } from "./ui.js";

/**
 * @typedef {{ id: number, title: string, source: string, url: string }} Link
 * @typedef {{ kind: string, text: string, verified: boolean, headlineOnly: boolean, pinned: boolean, links: Link[] }} Entry
 * @typedef {{ folder: string, entries: Entry[], omitted: number }} Section
 * @typedef {{ id: number, kind: string, periodStart: string, periodEnd: string, createdAt: string, itemCount: number, sections: Section[] }} Briefing
 */

/** @param {string} iso */
function when(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

class VzBriefing extends HTMLElement {
  /** @type {Briefing | null} */
  current = null;

  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        ${baseStyles}
        :host { display: block; }
        .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
        h2 { font-family: var(--font-display); font-style: italic; font-weight: 700; font-size: 34px; line-height: 1.1; margin: 0; color: var(--text-strong); }
        .period { color: var(--muted); font-size: 15px; }
        .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0 0; }
        h3 { font-family: var(--font-display); font-style: italic; font-size: 26px; margin: 22px 0 0; color: var(--accent); font-weight: 700; }
        .entry { background: var(--bg-raised); border: 1px solid var(--line); border-radius: 6px; padding: 14px 18px; margin-top: 12px; transition: border-color calc(.2s * var(--t)) ease, box-shadow calc(.2s * var(--t)) ease; }
        .entry:hover { border-color: var(--accent-dim); box-shadow: 0 6px 24px var(--glow); }
        .entry.pinned { border-left: 4px solid var(--accent); }
        .entry p { margin: 0; font-size: 18px; }
        .badge { display: inline-block; margin-left: 8px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line-strong); border-radius: 999px; padding: 0 8px; vertical-align: middle; }
        .links { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 2px; }
        .links li { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; border-top: 1px solid var(--line); padding-top: 6px; }
        .links a { flex: 1 1 220px; min-width: 0; overflow-wrap: anywhere; font-size: 15px; text-decoration: none; }
        .links a:hover { text-decoration: underline; }
        a, a:visited { color: var(--accent); }
        .links .src { color: var(--muted); }
        .links .votes { margin: 0; }
        .more { color: var(--muted); font-size: 14px; margin: 8px 0 0; }
        .empty { text-align: center; padding: 40px 12px; color: var(--muted); }
        .empty p { font-size: 18px; margin: 0 0 14px; }
        .note { min-height: 22px; color: var(--muted); font-size: 15px; margin: 8px 0 0; }
        @media (max-width: 640px) { h2 { font-size: 29px; } .entry p { font-size: 17px; } }
      </style>
      <div id="body"></div>
      <div id="note" class="note" role="status"></div>`;
  }

  /** @param {string} path */
  $(path) {
    return /** @type {HTMLElement} */ (/** @type {ShadowRoot} */ (this.shadowRoot).querySelector(path));
  }

  async load() {
    try {
      const { briefings } = await api("/api/briefings");
      const newest = briefings[0];
      this.current = newest ? (await api(`/api/briefings/${newest.id}`)).briefing : null;
      this.$("#note").textContent = "";
    } catch (error) {
      this.$("#note").textContent = messageOf(error);
    }
    this.paint();
  }

  /** @param {"ondemand" | "daily"} kind */
  async build(kind) {
    const note = this.$("#note");
    note.textContent = "Writing your briefing...";
    try {
      this.current = (await api("/api/briefings", { json: { kind } })).briefing;
      note.textContent = this.current && this.current.itemCount ? "" : "Nothing new has come in since the last one.";
    } catch (error) {
      note.textContent = messageOf(error);
    }
    this.paint();
  }

  async markRead() {
    const note = this.$("#note");
    if (!this.current) return;
    try {
      const { marked } = await api(`/api/briefings/${this.current.id}/read`, { method: "POST" });
      note.textContent = marked ? `Marked ${marked} item${marked === 1 ? "" : "s"} as read.` : "Those were all read already.";
    } catch (error) {
      note.textContent = messageOf(error);
    }
  }

  paint() {
    const body = this.$("#body");
    const briefing = this.current;
    const build = el("button", { type: "button", class: briefing ? "" : "primary", text: briefing ? "Write a fresh one" : "Write my briefing", onClick: () => this.build("ondemand") });
    if (!briefing || briefing.itemCount === 0) {
      body.replaceChildren(
        el("div", { class: "empty" }, el("p", { text: briefing ? "Nothing new to brief you on." : "No briefing yet." }), build),
      );
      return;
    }
    const mark = el("button", { type: "button", text: "Mark these read", onClick: () => this.markRead() });
    const read = el("a", { href: `/api/briefings/${briefing.id}?format=md`, target: "_blank", rel: "noopener", text: "Plain text" });
    read.style.alignSelf = "center";
    body.replaceChildren(
      el("div", { class: "head" }, el("h2", { text: "Your briefing" }), el("span", { class: "period", text: `${when(briefing.periodStart)} to ${when(briefing.periodEnd)}, ${briefing.itemCount} item${briefing.itemCount === 1 ? "" : "s"}` })),
      el("div", { class: "actions" }, build, mark, read),
      ...briefing.sections.flatMap((section) => this.section(section)),
    );
  }

  /** @param {Section} section */
  section(section) {
    return [
      el("h3", { text: section.folder || "Unfiled" }),
      el("div", { class: "flourish" }, el("i")),
      ...section.entries.map((entry) => this.entry(entry)),
      section.omitted ? el("p", { class: "more", text: `${section.omitted} more not shown here. They are in Reading.` }) : null,
    ].filter((node) => node !== null);
  }

  /** @param {Entry} entry */
  entry(entry) {
    const text = el("p", { text: entry.text });
    if (!entry.verified && !entry.headlineOnly) text.append(el("span", { class: "badge", title: "The supporting quote for this line was not found in the source, so check it.", text: "unchecked" }));
    if (entry.headlineOnly) text.append(el("span", { class: "badge", title: "No summary exists for this item yet; this is only its headline.", text: "headline" }));
    const links = el(
      "ul",
      { class: "links" },
      ...entry.links.map((link) =>
        el(
          "li",
          {},
          el("a", { href: /^https?:\/\//.test(link.url) ? link.url : "#", target: "_blank", rel: "noopener noreferrer" }, el("span", { text: link.title && link.title !== entry.text ? link.title : "Read the article" }), el("span", { class: "src", text: ` - ${link.source}` })),
          voteControls({ id: link.id }),
        ),
      ),
    );
    return el("article", { class: `entry${entry.pinned ? " pinned" : ""}` }, text, links);
  }
}

customElements.define("vz-briefing", VzBriefing);
