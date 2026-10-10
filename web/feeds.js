// @ts-check
// The Feeds screen: every subscription with its folder, its last error, and for a feed that needs a login, a lock badge with Replace login.
// Login values are never shown: the server only ever says which kind a feed uses.
import { LOGIN_BADGE, LOGIN_STYLES, loginPicker } from "./login.js";
import { api, baseStyles, el, messageOf } from "./ui.js";

const STYLES = `
  .wrap { max-width: 860px; }
  .head h2 { font-family: var(--font-display); font-weight: 500; font-size: 28px; margin: 0 0 4px; }
  .lede { margin: 0 0 14px; }
  ul.feeds { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  li.feed { border: 1px solid var(--line); border-radius: 6px; padding: 12px 16px; background: var(--bg-raised); }
  li.feed h3 { margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 14px; margin: 2px 0 0; overflow-wrap: anywhere; }
  .lock { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 0 8px; border: 1px solid var(--accent-dim); border-radius: 999px; color: var(--accent); font-size: 13px; font-weight: 400; }
  .broken { color: var(--down); }
  .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .row button { min-height: 40px; }
  form.replace { margin-top: 10px; display: grid; gap: 8px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  section.import { border: 1px solid var(--accent-dim); border-left: 4px solid var(--accent); border-radius: 6px; padding: 12px 18px 14px; margin: 0 0 16px; background: var(--bg-raised); }
  section.import h3 { margin: 0 0 4px; font-family: var(--font-display); font-weight: 500; font-size: 22px; }
  section.import p { margin: 4px 0; }
  .import .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
  .import textarea { min-height: 90px; font-family: var(--font-mono, monospace); font-size: 13px; }
  .import details { margin: 6px 0; border-top: 1px solid var(--line); padding-top: 6px; }
  .import summary { cursor: pointer; }
  .import ul.preview { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 2px; }
  .import ul.preview label { display: flex; gap: 8px; align-items: baseline; font-size: 15px; overflow-wrap: anywhere; }
  .import ul.preview input[type="checkbox"] { width: 18px; min-height: 18px; flex: none; }
  .import select { width: auto; min-height: 44px; }
  ${LOGIN_STYLES}
  [hidden] { display: none !important; }
`;

class VzFeeds extends HTMLElement {
  /** @type {any[]} */ sources = [];
  /** @type {number | null} */ replacing = null;

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    root.innerHTML = `<style>${baseStyles}${STYLES}</style>
      <div class="wrap">
        <div class="head"><h2>Feeds</h2><button id="importOpen" type="button" aria-expanded="false">Import from Inoreader</button></div>
        <p class="lede muted" id="lede"></p>
        <section id="import" class="import" hidden></section>
        <div id="status" role="status" class="muted"></div>
        <ul class="feeds" id="list"></ul>
      </div>`;
    this.$("importOpen").addEventListener("click", () => this.toggleImport());
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
      const [{ sources }, { backends }] = await Promise.all([api("/api/sources"), api("/api/secrets/status").catch(() => ({ backends: [] }))]);
      this.sources = sources;
      const usable = backends.filter((/** @type {any} */ b) => b.available).map((/** @type {any} */ b) => b.id);
      this.$("lede").textContent = usable.length ? `Logins are kept in your secret store (${usable.join(", ")}), never in the database.` : "No secret store is set up, so feeds that need a login cannot be added.";
      this.render();
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  toggleImport() {
    const panel = this.$("import");
    const open = panel.hidden;
    panel.hidden = !open;
    this.$("importOpen").setAttribute("aria-expanded", String(open));
    if (open) this.renderImport();
    else panel.replaceChildren();
  }

  /** The import panel: choose an OPML file, preview it, tick what to add, then (once the feeds are fetched) build the catch-up briefing. */
  renderImport() {
    const panel = this.$("import");
    const file = /** @type {HTMLInputElement} */ (el("input", { type: "file", accept: ".opml,.xml,text/xml,text/x-opml", "aria-label": "OPML file" }));
    const paste = /** @type {HTMLTextAreaElement} */ (el("textarea", { placeholder: "Or paste the OPML text here", "aria-label": "OPML text" }));
    const tier = /** @type {HTMLSelectElement} */ (el("select", { "aria-label": "Who may see these feeds' text" }, el("option", { value: "public", text: "Public feeds (a hosted model may read them)" }), el("option", { value: "private", text: "Private feeds (only local models read them)" })));
    const out = el("div", { role: "status" });
    const result = el("div");
    /** @type {{ entries: any[], text: string } | null} */
    let loaded = null;

    const preview = async () => {
      out.textContent = "";
      result.replaceChildren();
      try {
        const text = paste.value.trim() || (file.files?.[0] ? await file.files[0].text() : "");
        if (!text) throw new Error("Choose an OPML file or paste its text first");
        const found = await api("/api/import/opml/preview", { json: { opml: text } });
        loaded = { entries: found.entries, text };
        out.textContent = `${found.counts.total} feeds in ${found.counts.folders} folders: ${found.counts.new} new, ${found.counts.subscribed} already subscribed${found.counts.invalid ? `, ${found.counts.invalid} skipped because their address is not usable` : ""}.`;
        result.replaceChildren(this.importList(found.entries, found.counts.new, async (skip) => {
          if (!loaded) return;
          try {
            const done = await api("/api/import/opml", { json: { opml: loaded.text, tier: tier.value, skip } });
            out.textContent = `Added ${done.added} feeds. They are fetched in the background over the next few minutes.`;
            result.replaceChildren(this.catchUp());
            await this.load();
          } catch (error) {
            out.textContent = messageOf(error);
          }
        }));
      } catch (error) {
        out.textContent = messageOf(error);
      }
    };

    panel.replaceChildren(
      el("h3", { text: "Import from Inoreader" }),
      el("p", { class: "muted", text: "In Inoreader open Preferences, then Import / Export, and download the OPML file. Your folders come along. Nothing else is imported: your votes and your taste start fresh here." }),
      el("div", { class: "controls" }, file, tier, el("button", { type: "button", class: "primary", text: "Preview", onClick: preview })),
      paste,
      out,
      result,
    );
  }

  /** @param {any[]} entries @param {number} newCount @param {(skip: string[]) => void} onImport */
  importList(entries, newCount, onImport) {
    const wrap = el("div");
    /** @type {Map<string, HTMLInputElement>} */
    const boxes = new Map();
    const byFolder = new Map();
    for (const e of entries) byFolder.set(e.folder, [...(byFolder.get(e.folder) ?? []), e]);
    for (const [folder, list] of [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const items = list.map((/** @type {any} */ e) => {
        const box = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox", checked: e.status === "new", disabled: e.status !== "new", "aria-label": e.title || e.url }));
        boxes.set(e.url, box);
        return el("li", {}, el("label", {}, box, el("span", { text: `${e.title || e.url}${e.kind === "youtube" ? " (YouTube)" : ""}${e.status === "subscribed" ? " - already subscribed" : ""}` })));
      });
      wrap.append(el("details", { open: list.length <= 12 }, el("summary", { text: `${folder || "(no folder)"} - ${list.length}` }), el("ul", { class: "preview" }, ...items)));
    }
    const go = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "primary", text: `Add ${newCount} feeds`, disabled: newCount === 0 }));
    const recount = () => {
      const picked = [...boxes.values()].filter((b) => b.checked && !b.disabled).length;
      go.textContent = `Add ${picked} feeds`;
      go.disabled = picked === 0;
    };
    for (const box of boxes.values()) box.addEventListener("change", recount);
    go.addEventListener("click", () => onImport([...boxes.entries()].filter(([, b]) => !b.checked && !b.disabled).map(([url]) => url)));
    wrap.append(el("div", { class: "controls" }, go));
    return wrap;
  }

  /** After an import: wait for the first fetch, then condense the backlog into one briefing and offer to mark the rest read. */
  catchUp() {
    const box = el("div", { class: "catchup" });
    const text = el("p", { role: "status" });
    const action = el("div", { class: "controls" });
    box.append(el("h3", { text: "Catch up" }), text, action);
    const build = el("button", { type: "button", class: "primary", text: "Build the catch-up briefing" });
    let built = false;
    const tick = async () => {
      if (built) return;
      try {
        const { sources } = await api("/api/sources");
        const fetched = sources.filter((/** @type {any} */ s) => s.lastFetchedAt).length;
        text.textContent = `${fetched} of ${sources.length} feeds fetched so far. Build the briefing once most of them are in; you can build it again later.`;
      } catch {
        // The next tick tries again.
      }
    };
    build.addEventListener("click", async () => {
      try {
        const { briefing } = await api("/api/briefings", { json: { kind: "catchup" } });
        built = true;
        const { unread } = await api("/api/health");
        const entries = briefing.sections.reduce((/** @type {number} */ n, /** @type {any} */ s) => n + s.entries.length, 0);
        text.textContent = `The catch-up briefing has ${entries} entries drawn from ${briefing.itemCount} items. ${unread} items are unread in all.`;
        const open = el("a", { href: `/api/briefings/${briefing.id}?format=md`, target: "_blank", rel: "noopener", text: "Read it" });
        const mark = el("button", { type: "button", text: `Mark all ${unread} unread as read`, onClick: async () => {
          try {
            const { marked } = await api("/api/items/read-all", { json: {} });
            text.textContent = `Marked ${marked} items read. From here on Reading shows only what is new.`;
            action.replaceChildren();
          } catch (error) {
            text.textContent = messageOf(error);
          }
        } });
        action.replaceChildren(open, ...(unread > 0 ? [mark] : []));
      } catch (error) {
        text.textContent = messageOf(error);
      }
    });
    action.append(build);
    void tick();
    const timer = setInterval(() => {
      if (!box.isConnected) clearInterval(timer);
      else void tick();
    }, 5000);
    return box;
  }

  render() {
    const list = this.$("list");
    list.replaceChildren(...this.sources.map((s) => this.row(s)));
    if (!this.sources.length) this.say("No feeds yet. Add one from Reading.");
  }

  /** @param {any} source */
  row(source) {
    const name = source.title || source.url;
    const heading = el("h3", { text: name });
    if (source.auth) heading.append(el("span", { class: "lock", title: `This feed needs a login (${LOGIN_BADGE[source.auth]})`, text: `Login: ${LOGIN_BADGE[source.auth]}` }));
    const meta = [source.folder ? `Folder: ${source.folder}` : "", source.title ? source.url : ""].filter(Boolean).join(" - ");
    const item = el("li", { class: "feed" }, heading, meta ? el("p", { class: "meta", text: meta }) : null, source.lastError ? el("p", { class: "meta broken", role: "status", text: `Last fetch failed: ${source.lastError}` }) : null);
    if (source.auth) item.append(this.loginControls(source));
    return item;
  }

  /** @param {any} source */
  loginControls(source) {
    const holder = el("div", { class: "login-controls" });
    const open = this.replacing === source.id;
    const replace = el("button", { type: "button", text: open ? "Cancel" : "Replace login", "aria-expanded": String(open), onClick: () => {
      this.replacing = open ? null : source.id;
      this.render();
    } });
    const actions = el("div", { class: "row" }, replace);
    if (source.auth !== "url") {
      actions.append(
        el("button", { type: "button", class: "quiet danger", text: "Remove login", onClick: async () => {
          try {
            await api(`/api/sources/${source.id}/login`, { method: "DELETE" });
            this.say("The login was removed. This feed will be fetched without one.");
            await this.load();
          } catch (error) {
            this.say(messageOf(error));
          }
        } }),
      );
    }
    holder.append(actions);
    if (open) {
      const picker = loginPicker({ idPrefix: `replace-${source.id}`, allowed: source.auth === "url" ? ["url"] : ["basic", "header", "cookie"] });
      const form = el("form", { class: "replace" }, picker.select, picker.fields, el("div", { class: "row" }, el("button", { type: "submit", class: "primary", text: "Save login" })));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          const login = picker.read();
          if (!login) throw new Error("Choose what kind of login this feed needs");
          await api(`/api/sources/${source.id}/login`, { method: "PUT", json: { login } });
          picker.clear();
          this.replacing = null;
          this.say("The login was replaced. The feed will be fetched again shortly.");
          await this.load();
        } catch (error) {
          this.say(messageOf(error));
        }
      });
      holder.append(form);
    }
    return holder;
  }
}

customElements.define("vz-feeds", VzFeeds);
