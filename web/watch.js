// @ts-check
// The Watch screen: sign in to Trakt, see what is next in each show, and where it can be watched.
// Everything from Trakt and TMDB is shown as text, never as markup; only Trakt's own poster hosts are loaded as images.
import { api, baseStyles, el, messageOf } from "./ui.js";

const STYLES = `
  .wrap { max-width: 860px; }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .head h2 { font-family: var(--font-display); font-weight: 500; font-size: 28px; margin: 0 0 4px; }
  .lede { margin: 0 0 14px; }
  .panel { border: 1px solid var(--line); border-radius: 6px; padding: 12px 16px; margin: 0 0 14px; background: var(--bg-raised); }
  .panel h3 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
  .row input[type="text"] { flex: 1 1 220px; width: auto; min-width: 0; }
  .badge { display: inline-block; padding: 0 8px; border: 1px solid var(--accent-dim); border-radius: 999px; color: var(--accent); font-size: 13px; }
  ul.shows { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  li.show { display: grid; grid-template-columns: 64px 1fr; gap: 14px; border: 1px solid var(--line); border-radius: 6px; padding: 12px; background: var(--bg-raised); }
  li.show .poster { width: 64px; height: 96px; border-radius: 3px; background: var(--bg); object-fit: cover; border: 1px solid var(--line); }
  li.show h3 { margin: 0; font-size: 18px; font-weight: 600; overflow-wrap: anywhere; }
  li.show h3 a { color: var(--text-strong); text-decoration: none; }
  li.show h3 a:hover { color: var(--accent); }
  .next { margin: 2px 0 0; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 15px; margin: 2px 0 0; }
  .bar { height: 4px; background: var(--line); border-radius: 2px; margin: 8px 0 2px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--accent-dim); }
  .when { margin: 6px 0 0; font-size: 15px; }
  .when.soon { color: var(--accent); }
  .where { margin: 8px 0 0; display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
  .where .mine { background: var(--glow); border-color: var(--accent); font-weight: 700; }
  .where .other { color: var(--muted); border-color: var(--line-strong); }
  details.elsewhere { margin-top: 6px; font-size: 15px; color: var(--muted); }
  details.elsewhere summary { cursor: pointer; }
  details.elsewhere p { margin: 4px 0; overflow-wrap: anywhere; }
  fieldset.services { border: 1px solid var(--line); border-radius: 4px; margin: 10px 0; padding: 8px 12px; max-height: 220px; overflow: auto; }
  fieldset.services label { display: inline-flex; gap: 6px; align-items: center; margin: 4px 14px 4px 0; }
  footer.credit { margin: 18px 0 0; color: var(--muted); font-size: 14px; }
  footer.credit p { margin: 4px 0; }
  footer.credit a { color: var(--muted); }
  [hidden] { display: none !important; }
  @media (max-width: 520px) { li.show { grid-template-columns: 48px 1fr; } li.show .poster { width: 48px; height: 72px; } }
`;

/** @param {number} ms */
function countdown(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days >= 1) return `${days} ${days === 1 ? "day" : "days"}${hours ? ` ${hours} h` : ""}`;
  if (hours >= 1) return `${hours} h ${minutes % 60} min`;
  return `${minutes} min`;
}

/** @param {string | null} iso */
function agoText(iso) {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

/** @param {{ season: number, number: number }} next */
const label = (next) => `S${String(next.season).padStart(2, "0")}E${String(next.number).padStart(2, "0")}`;

class VzWatch extends HTMLElement {
  /** @type {any} */ status = null;
  /** @type {any[]} */ items = [];
  /** @type {{ state: string, manualCode: boolean } | null} */ signIn = null;
  /** @type {number | undefined} */ clock;

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    root.innerHTML = `<style>${baseStyles}${STYLES}</style>
      <div class="wrap">
        <div class="head"><h2>Watch</h2><span id="who" class="badge" hidden></span></div>
        <p class="lede muted">What is next in each show you follow on Trakt, and where you can watch it.</p>
        <div id="status" role="status" class="muted"></div>
        <section id="connect" class="panel" hidden></section>
        <section id="tools" class="panel" hidden></section>
        <ul class="shows" id="list"></ul>
        <footer class="credit" id="credit" hidden></footer>
      </div>`;
    this.clock = window.setInterval(() => this.renderList(), 60_000);
  }

  disconnectedCallback() {
    window.clearInterval(this.clock);
  }

  /** @param {string} id */
  $(id) {
    return /** @type {HTMLElement} */ (/** @type {ShadowRoot} */ (this.shadowRoot).getElementById(id));
  }

  /** @param {string} text */
  say(text) {
    this.$("status").textContent = text;
  }

  /** @param {string} [note] The part of the address after #/watch/, which is "denied" when Trakt sent the person back without approving. */
  async load(note = "") {
    try {
      this.status = await api("/api/watch");
      this.say(note === "denied" ? "Trakt did not finish the sign-in. Try connecting again." : this.status.lastError || "");
      if (this.status.connected) this.items = (await api("/api/watch/up-next")).items;
      else this.items = [];
      this.render();
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  render() {
    const s = this.status;
    const who = this.$("who");
    who.hidden = !s.connected || !s.username;
    who.textContent = s.vip ? `${s.username} (VIP)` : s.username;
    this.renderConnect();
    this.renderTools();
    this.renderList();
    const credit = this.$("credit");
    credit.hidden = !s.attribution.length;
    credit.replaceChildren(
      ...s.attribution.map((/** @type {string} */ text) => el("p", { text })),
      el("p", {}, el("a", { href: "https://www.themoviedb.org", target: "_blank", rel: "noopener noreferrer", text: "themoviedb.org" }), " | ", el("a", { href: "https://www.justwatch.com", target: "_blank", rel: "noopener noreferrer", text: "justwatch.com" })),
    );
  }

  renderConnect() {
    const s = this.status;
    const box = this.$("connect");
    box.hidden = s.connected;
    if (s.connected) return;
    if (!s.traktConfigured) {
      box.replaceChildren(el("h3", { text: "Trakt is not set up" }), el("p", { class: "muted", text: "Set JUHANDU_TRAKT_CLIENT_ID (or store the secret trakt/client_id), then reload. docs/SETUP.md has the steps." }));
      return;
    }
    const start = el("button", { type: "button", class: "primary", text: this.signIn ? "Start again" : "Connect to Trakt", onclick: () => this.startSignIn() });
    const parts = [el("h3", { text: "Connect your Trakt account" }), el("p", { class: "muted", text: "Juhandu reads your watch progress from Trakt. It never sees your Trakt password, and disconnecting removes the saved sign-in and the local copy of your list." }), el("div", { class: "row" }, start)];
    if (this.signIn?.manualCode) {
      const code = /** @type {HTMLInputElement} */ (el("input", { type: "text", placeholder: "Code from Trakt", "aria-label": "Code from Trakt", autocomplete: "off" }));
      const finish = el("button", { type: "button", class: "primary", text: "Finish", onclick: () => this.finishSignIn(code.value) });
      parts.push(el("p", { class: "muted small", text: "Approve Juhandu on the Trakt page that just opened, then paste the code it shows here." }), el("div", { class: "row" }, code, finish));
    }
    box.replaceChildren(...parts);
  }

  async startSignIn() {
    try {
      const { url, state, manualCode } = await api("/api/watch/connect", { method: "POST", json: {} });
      this.signIn = { state, manualCode };
      if (manualCode) {
        window.open(url, "_blank", "noopener,noreferrer");
        this.renderConnect();
      } else {
        location.href = url;
      }
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  /** @param {string} code */
  async finishSignIn(code) {
    if (!this.signIn || !code.trim()) return this.say("Paste the code Trakt showed.");
    this.say("Signing in and reading your list...");
    try {
      const done = await api("/api/watch/connect/finish", { method: "POST", json: { code: code.trim(), state: this.signIn.state } });
      this.signIn = null;
      await this.load();
      if (done.syncError) this.say(done.syncError);
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  renderTools() {
    const s = this.status;
    const box = this.$("tools");
    box.hidden = !s.connected;
    if (!s.connected) return;
    const sync = el("button", { type: "button", text: "Sync now", onclick: () => this.syncNow(sync) });
    const out = el("button", { type: "button", class: "quiet danger", text: "Disconnect", onclick: () => this.disconnect() });
    const region = /** @type {HTMLInputElement} */ (el("input", { type: "text", value: s.region, maxlength: 2, "aria-label": "Country code", style: "max-width: 90px; flex: 0 0 auto" }));
    const boxes = s.providerChoices.map((/** @type {string} */ name) => {
      const input = /** @type {HTMLInputElement} */ (el("input", { type: "checkbox", value: name, checked: s.services.includes(name) }));
      return el("label", {}, input, name);
    });
    const services = el("fieldset", { class: "services" }, el("legend", { class: "legend", text: "Your services" }), ...(boxes.length ? boxes : [el("span", { class: "muted", text: "Services appear here after the first lookup." })]));
    const save = el("button", { type: "button", text: "Save", onclick: () => this.saveSettings(region.value, services) });
    box.replaceChildren(
      el("div", { class: "row" }, el("span", { class: "muted", text: `Synced ${agoText(s.lastSyncAt)}` }), sync, out),
      el("details", {}, el("summary", { text: "Country and services" }), el("div", { class: "row" }, el("label", { class: "muted", text: "Country" }), region), services, el("div", { class: "row" }, save)),
    );
  }

  /** @param {HTMLElement} button */
  async syncNow(button) {
    /** @type {HTMLButtonElement} */ (button).disabled = true;
    this.say("Syncing with Trakt...");
    try {
      const run = await api("/api/watch/sync", { method: "POST", json: {} });
      this.items = run.items;
      this.say("");
      await this.load();
    } catch (error) {
      this.say(messageOf(error));
      /** @type {HTMLButtonElement} */ (button).disabled = false;
    }
  }

  async disconnect() {
    if (!confirm("Disconnect Trakt? The saved sign-in and the local copy of your list are removed. Nothing changes on Trakt.")) return;
    try {
      this.status = await api("/api/watch/connect", { method: "DELETE" });
      this.items = [];
      this.signIn = null;
      this.render();
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  /** @param {string} region @param {HTMLElement} services */
  async saveSettings(region, services) {
    const chosen = [...services.querySelectorAll("input:checked")].map((i) => /** @type {HTMLInputElement} */ (i).value);
    try {
      this.status = await api("/api/watch/settings", { method: "PUT", json: { region, services: chosen } });
      this.items = (await api("/api/watch/up-next")).items;
      this.say("Saved.");
      this.render();
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  renderList() {
    const list = this.$("list");
    if (!this.status?.connected) return list.replaceChildren();
    if (!this.items.length) return list.replaceChildren(el("li", { class: "muted", text: "Nothing is up next. Watch something on Trakt and it appears here." }));
    list.replaceChildren(...this.items.map((item) => this.card(item)));
  }

  /** @param {any} item */
  card(item) {
    const percent = item.aired ? Math.round((item.completed / item.aired) * 100) : 0;
    const title = el("h3", {}, el("a", { href: item.traktUrl, target: "_blank", rel: "noopener noreferrer", text: item.year ? `${item.title} (${item.year})` : item.title }));
    const body = [title];
    if (item.next) body.push(el("p", { class: "next", text: item.next.title ? `${label(item.next)}  ${item.next.title}` : label(item.next) }));
    body.push(el("div", { class: "bar", role: "img", "aria-label": `${item.completed} of ${item.aired} aired episodes watched` }, el("span", { style: `width: ${percent}%` })), el("p", { class: "meta", text: `${item.completed} of ${item.aired} watched` }));
    const when = this.when(item);
    if (when) body.push(when);
    const where = this.where(item);
    if (where) body.push(...where);
    const poster = item.poster ? el("img", { class: "poster", src: item.poster, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }) : el("div", { class: "poster" });
    return el("li", { class: "show" }, poster, el("div", {}, ...body));
  }

  /** @param {any} item */
  when(item) {
    if (!item.next) return null;
    if (item.availability.state === "upcoming") return el("p", { class: "when soon", text: `Airs in ${countdown(item.availability.msUntil)}` });
    if (item.availability.state === "aired") return el("p", { class: "when", text: "Aired, ready to watch" });
    return null;
  }

  /** @param {any} item */
  where(item) {
    const w = item.where;
    if (!w) return null;
    const chips = [...w.mine.map((/** @type {{ name: string }} */ o) => el("span", { class: "chip mine", text: o.name })), ...w.home.map((/** @type {{ name: string, kind: string }} */ o) => el("span", { class: "chip other", text: o.kind === "rent" || o.kind === "buy" ? `${o.name} (${o.kind})` : o.name }))];
    const out = [];
    if (chips.length) out.push(el("div", { class: "where" }, ...chips));
    else out.push(el("p", { class: "meta", text: `Not listed in ${this.status.region} right now.` }));
    if (w.elsewhere.length) {
      const first = w.elsewhere.slice(0, 12);
      out.push(el("details", { class: "elsewhere" }, el("summary", { text: `Also streaming in ${w.elsewhere.length} other ${w.elsewhere.length === 1 ? "country" : "countries"}` }), ...first.map((/** @type {{ country: string, providers: string[], mine: string[] }} */ e) => el("p", { text: `${e.country}: ${e.providers.join(", ")}${e.mine.length ? ` (yours: ${e.mine.join(", ")})` : ""}` }))));
    }
    return out;
  }
}

customElements.define("vz-watch", VzWatch);
