// @ts-check
// The shell: header, navigation (Briefing, Reading, Filtered out, Rules, Feeds, Pipes), theme and effects switches, the item lists,
// the phone tab bar and the app install and offline pieces. Everything from feeds is shown as text, never as markup.
import "./briefing.js";
import "./rules.js";
import "./feeds.js";
import "./pipes.js";
import "./connect.js";
import { LOGIN_STYLES, loginPicker } from "./login.js";
import { api, applyEffects, applyTheme, baseStyles, currentTheme, effectsOn, el, initSettings, messageOf, SEAL, THEMES, voteControls } from "./ui.js";

initSettings();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // No offline copy, but everything else works.
    });
  });
}

/** @type {any} */
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  document.querySelector("vz-app")?.dispatchEvent(new CustomEvent("installable"));
});

const ICONS = {
  system: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/></svg>',
  light: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  dark: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
  effects: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
};

/** @param {string} svg */
function icon(svg) {
  const holder = document.createElement("span");
  holder.className = "icon";
  holder.innerHTML = svg; // Static markup defined above; no feed or user text reaches it.
  return holder;
}

const VIEWS = /** @type {const} */ ([
  ["briefing", "Briefing"],
  ["reading", "Reading"],
  ["filtered", "Filtered out"],
  ["rules", "Rules"],
  ["feeds", "Feeds"],
  ["pipes", "Pipes"],
  ["connect", "Connect"],
]);

class VzApp extends HTMLElement {
  /** @type {"briefing" | "reading" | "filtered" | "rules" | "feeds" | "pipes" | "connect"} */
  view = "briefing";

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    this.view = this.viewFromHash();
    this.render();
    window.addEventListener("hashchange", () => {
      this.view = this.viewFromHash();
      this.show();
    });
    this.show();
  }

  viewFromHash() {
    const name = location.hash.replace(/^#\/?/, "");
    return name === "reading" || name === "filtered" || name === "rules" || name === "feeds" || name === "pipes" || name === "connect" ? name : "briefing";
  }

  /** @param {string} path */
  all(path) {
    return /** @type {HTMLElement[]} */ ([.../** @type {ShadowRoot} */ (this.shadowRoot).querySelectorAll(path)]);
  }

  /** @param {string} path */
  $(path) {
    return /** @type {HTMLElement} */ (/** @type {ShadowRoot} */ (this.shadowRoot).querySelector(path));
  }

  show() {
    for (const [name] of VIEWS) {
      for (const tab of this.all(`[data-view="${name}"]`)) tab.setAttribute("aria-current", name === this.view ? "page" : "false");
    }
    this.$("#more-tab").setAttribute("aria-current", this.view === "rules" || this.view === "feeds" || this.view === "pipes" || this.view === "connect" ? "page" : "false");
    const briefing = this.$("vz-briefing");
    briefing.hidden = this.view !== "briefing";
    if (this.view === "briefing") /** @type {any} */ (briefing).load();
    const feedForm = this.$("#add");
    const items = this.$("#items");
    const rules = this.$("vz-rules");
    const showItems = this.view === "reading" || this.view === "filtered";
    const feeds = this.$("vz-feeds");
    feedForm.hidden = this.view !== "reading";
    items.hidden = !showItems;
    this.$("#status").hidden = !showItems;
    rules.hidden = this.view !== "rules";
    feeds.hidden = this.view !== "feeds";
    if (this.view === "feeds") /** @type {any} */ (feeds).load();
    const pipes = this.$("vz-pipes");
    pipes.hidden = this.view !== "pipes";
    if (this.view === "pipes") /** @type {any} */ (pipes).load();
    const connect = this.$("vz-connect");
    connect.hidden = this.view !== "connect";
    if (this.view === "connect") /** @type {any} */ (connect).load();
    if (showItems) this.refresh();
    this.loadAsk();
    for (const shown of [briefing, items, rules, feeds, pipes, connect]) {
      if (shown.hidden) continue;
      shown.classList.remove("enter");
      void shown.offsetWidth;
      shown.classList.add("enter");
    }
    window.scrollTo(0, 0);
  }

  /** The borderline question: now and then one unvoted item the AI is unsure about, at the top of Reading. */
  async loadAsk() {
    const box = this.$("#ask");
    if (this.view !== "reading") {
      box.hidden = true;
      return;
    }
    if (!navigator.onLine) {
      box.hidden = true;
      return;
    }
    try {
      const { item } = await api("/api/learning/ask");
      box.hidden = !item;
      box.replaceChildren(...(item ? [this.askCard(item)] : []));
    } catch {
      box.hidden = true;
    }
  }

  /** @param {any} item */
  askCard(item) {
    const box = this.$("#ask");
    const thanks = (/** @type {string} */ text) => box.replaceChildren(el("p", { class: "muted", role: "status", text }));
    const article = this.card(item, false, (/** @type {number} */ vote) => {
      if (vote !== 0) setTimeout(() => thanks("Thank you. That teaches the AI more than most votes do."), 900);
    });
    const skip = el("button", {
      type: "button",
      class: "quiet",
      text: "Skip",
      onClick: async () => {
        try {
          await api("/api/learning/ask/skip", { json: { itemId: item.id } });
          box.hidden = true;
          box.replaceChildren();
        } catch (error) {
          this.$("#status").textContent = messageOf(error);
        }
      },
    });
    const stop = el("button", {
      type: "button",
      class: "quiet",
      text: "Stop asking",
      onClick: async () => {
        try {
          await api("/api/settings/learning", { method: "PUT", json: { enabled: false } });
          box.hidden = true;
          box.replaceChildren();
          this.$("#status").textContent = "Okay, no more questions. You can turn them back on under Rules, in Learning.";
        } catch (error) {
          this.$("#status").textContent = messageOf(error);
        }
      },
    });
    return el("section", { class: "askbox", "aria-label": "A question for you" }, el("p", { class: "lead", text: "The AI is unsure about this one. Would you like it?" }), article, el("div", { class: "row" }, skip, stop));
  }

  async refresh() {
    const list = this.$("#items");
    const status = this.$("#status");
    const filtered = this.view === "filtered";
    try {
      const [{ items }, health] = await Promise.all([api(`/api/items?limit=100&view=${filtered ? "filtered" : "inbox"}`), api("/api/health")]);
      status.textContent = filtered ? (items.length ? `${items.length} hidden by your rules. Restore anything that should not have been hidden.` : "Nothing has been filtered out.") : `${health.sources} sources, ${health.items} items, ${health.unread} unread`;
      list.replaceChildren(...items.map((/** @type {any} */ item) => this.card(item, filtered)));
    } catch (error) {
      status.textContent = messageOf(error);
    }
  }

  /** @param {any} item @param {boolean} filtered @param {((vote: number) => void) | null} [onAsk] set when this card is the borderline question */
  card(item, filtered, onAsk = null) {
    const title = el("a", { href: /^https?:\/\//.test(item.url) ? item.url : "#", target: "_blank", rel: "noopener noreferrer", text: item.title || "(untitled)" });
    const meta = el("div", { class: "meta", text: [item.sourceTitle, item.publishedAt ? new Date(item.publishedAt).toLocaleString() : ""].filter(Boolean).join(" - ") });
    const summary = el("p", { text: item.summary ? item.summary.text : item.summaryText });
    if (item.summary) summary.title = item.summary.verified ? "Summary written by a local model; its supporting quote was found in the source." : "Summary written by a local model; its supporting quote was not found in the source, so check it.";
    const spoken = item.video
      ? el("details", { class: "video" }, el("summary", { text: "What the video says" }), el("p", { class: "reading", text: item.video.text }), el("p", { class: "meta", text: `Read ${{ gemini: "by Gemini", captions: "from the captions", local: "on this computer" }[/** @type {string} */ (item.video.rung)] ?? "by the video reader"}.` }))
      : null;
    const card = el("article", {}, meta, title, summary, ...(spoken ? [spoken] : []), voteControls(item, onAsk ? { alwaysWhy: true, onVote: onAsk } : {}));
    if (filtered) {
      const hits = (item.decision?.hits ?? []).filter((/** @type {any} */ h) => !h.shadow);
      const blocks = hits.filter((/** @type {any} */ h) => h.kind === "block");
      const why = (blocks.length ? blocks : hits).map((/** @type {any} */ h) => h.detail);
      const restore = el("button", {
        type: "button",
        text: "Restore",
        onClick: async () => {
          try {
            await api(`/api/items/${item.id}/restore`, { method: "POST" });
            card.remove();
            this.$("#status").textContent = "Restored. It is back in Reading.";
          } catch (error) {
            this.$("#status").textContent = messageOf(error);
          }
        },
      });
      card.append(el("p", { class: "why muted", text: why.length ? `Hidden by: ${why.join("; ")}` : "Hidden by the taste score." }), restore);
    }
    return card;
  }

  /** The phone's bottom tab bar and the More sheet that holds the other screens and the app settings. */
  buildPhoneNav() {
    const tab = (/** @type {string} */ name, /** @type {string} */ label, /** @type {string} */ path) => {
      const link = el("a", { href: `#/${name}`, "data-view": name });
      link.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${path}</svg>`; // Static markup.
      link.append(label);
      return link;
    };
    const more = el("button", { type: "button", id: "more-tab", "aria-haspopup": "dialog" });
    more.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="3"/></svg>';
    more.append("More");
    this.$("#tabbar").append(
      tab("briefing", "Briefing", '<path d="M5 4h11l3 3v13H5z"/><path d="M8 10h8M8 14h8M8 18h5"/>'),
      tab("reading", "Reading", '<path d="M3 5.5c3-1.5 6-1.5 9 .5 3-2 6-2 9-.5V19c-3-1.5-6-1.5-9 .5-3-2-6-2-9-.5z"/><path d="M12 6v13.5"/>'),
      tab("filtered", "Filtered", '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>'),
      more,
    );
    const dialog = /** @type {HTMLDialogElement} */ (this.$("#more"));
    const sheet = this.$("#sheet");
    const close = () => dialog.close();
    const link = (/** @type {string} */ name, /** @type {string} */ label) => el("a", { href: `#/${name}`, "data-view": name, text: label, onClick: close });
    const install = el("button", { type: "button", text: "Install Juhandu as an app", hidden: !installPrompt, onClick: async () => {
      close();
      const prompt = installPrompt;
      installPrompt = null;
      install.hidden = true;
      await prompt?.prompt();
    } });
    this.addEventListener("installable", () => {
      install.hidden = !installPrompt;
    });
    const clearNote = el("p", { class: "muted small", role: "status" });
    const clear = el("button", { type: "button", text: "Clear the offline copy", onClick: async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith("juhandu-data")).map((n) => caches.delete(n)));
        clearNote.textContent = "The saved items and briefings on this device are gone.";
      } catch {
        clearNote.textContent = "There was no offline copy to clear.";
      }
    } });
    sheet.append(el("h2", { text: "More" }), link("rules", "Rules"), link("feeds", "Feeds"), link("pipes", "Pipes"), link("connect", "Connect"), el("hr"), install, clear, clearNote);
    more.addEventListener("click", () => dialog.showModal());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  render() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    root.innerHTML = `
      <style>
        ${baseStyles}
        :host { display: block; max-width: 880px; margin: 0 auto; padding: 24px 20px 64px; }
        header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 12px; }
        .brand { display: flex; align-items: center; gap: 12px; color: var(--accent); }
        .seal { display: inline-grid; place-items: center; width: 40px; height: 40px; }
        .seal svg { width: 40px; height: 40px; }
        .fx .seal svg { animation: turn calc(1.4s * var(--t)) ease-out 1; }
        @keyframes turn { from { transform: rotate(-200deg) scale(.6); opacity: 0; } to { transform: none; opacity: 1; } }
        h1 { font-family: var(--font-display); font-style: italic; font-weight: 700; font-size: 44px; line-height: 1.1; margin: 0; color: var(--accent); }
        .tools { display: flex; gap: 4px; }
        .tools button { padding: 0; width: 44px; display: inline-grid; place-items: center; border-color: transparent; color: var(--muted); }
        .tools button[aria-pressed="false"] { opacity: .5; }
        nav { display: flex; gap: 22px; margin: 10px 0 14px; border-bottom: 1px solid var(--line); overflow-x: auto; overflow-y: hidden; }
        nav a { padding: 10px 0; color: var(--muted); text-decoration: none; letter-spacing: .06em; text-transform: uppercase; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
        nav a:hover { color: var(--text-strong); }
        nav a[aria-current="page"] { color: var(--accent); border-bottom-color: var(--accent); }
        form { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0; }
        form input { flex: 1 1 280px; width: auto; }
        .login-row { flex-basis: 100%; display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; }
        .login-row select { flex: 0 1 340px; width: auto; }
        #add .login-fields input { flex: initial; }
        ${LOGIN_STYLES}
        #status { color: var(--muted); font-size: 15px; min-height: 24px; margin: 6px 0; }
        article { background: var(--bg-raised); border: 1px solid var(--line); border-radius: 6px; padding: 16px 20px; margin-top: 14px; }
        .fx article { transition: border-color .2s ease, box-shadow .2s ease; }
        .fx article:hover { border-color: var(--accent-dim); box-shadow: 0 6px 24px var(--glow); }
        article a { font-family: var(--font-display); font-weight: 700; font-size: 24px; line-height: 1.15; color: var(--text-strong); text-decoration: none; overflow-wrap: anywhere; }
        article a:hover { color: var(--accent); }
        article a:visited { color: var(--muted); }
        .meta { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
        article p { margin: 8px 0 0; }
        article .why { font-size: 14px; }
        article details.video { margin-top: 10px; }
        article details.video summary { cursor: pointer; color: var(--muted); min-height: 32px; display: flex; align-items: center; }
        article details.video .reading { white-space: pre-wrap; font-size: 15px; }
        article button { margin-top: 10px; }
        .askbox { border: 1px solid var(--accent-dim); border-left: 4px solid var(--accent); border-radius: 6px; padding: 12px 18px 8px; margin: 10px 0 16px; background: var(--bg-raised); }
        .askbox .lead { margin: 0; font-family: var(--font-display); font-style: italic; font-size: 20px; color: var(--accent); }
        .askbox article { background: transparent; border: 0; padding: 4px 0 0; margin-top: 4px; }
        .askbox .row { display: flex; gap: 6px; margin-bottom: 4px; }
        .askbox .row button { margin-top: 0; }
        article .votes button { margin-top: 0; }
        [hidden] { display: none !important; }
        #offline { margin: 10px 0 0; padding: 8px 14px; border: 1px solid var(--accent-dim); border-radius: 6px; color: var(--accent); background: var(--bg-raised); font-size: 15px; }
        .tabbar { display: none; }
        dialog { width: min(420px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--bg-raised); color: var(--text); }
        dialog::backdrop { background: rgba(0, 0, 0, .55); }
        dialog[open] { animation: rise calc(.22s * var(--t)) ease both; }
        .sheet { padding: 8px 8px 12px; display: grid; gap: 2px; }
        .sheet h2 { font-family: var(--font-display); font-style: italic; margin: 8px 12px; font-size: 24px; color: var(--accent); }
        .sheet a, .sheet button { display: flex; align-items: center; min-height: 48px; padding: 0 14px; border: 0; border-radius: 6px; color: var(--text); text-decoration: none; font-size: 18px; text-align: left; width: 100%; justify-content: flex-start; }
        .sheet a:hover, .sheet button:hover { background: var(--glow); color: var(--accent); }
        .sheet a[aria-current="page"] { color: var(--accent); }
        .sheet .small { padding: 4px 14px 0; }
        .sheet hr { border: 0; border-top: 1px solid var(--line); margin: 6px 12px; width: calc(100% - 24px); }
        @media (min-width: 1100px) {
          :host { max-width: 1180px; }
          #items { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 0 18px; align-items: start; }
        }
        @media (min-width: 1800px) {
          :host { max-width: 1560px; font-size: 19px; }
          #items { grid-template-columns: repeat(auto-fill, minmax(480px, 1fr)); }
        }
        @media (max-width: 720px) {
          nav { display: none; }
          h1 { font-size: 36px; }
          .seal, .seal svg { width: 34px; height: 34px; }
          :host { padding: 14px 16px calc(96px + env(safe-area-inset-bottom)); }
          .tabbar { display: grid; grid-template-columns: repeat(4, 1fr); position: fixed; left: 0; right: 0; bottom: 0; z-index: 5; background: var(--bg-raised); border-top: 1px solid var(--line-strong); box-shadow: 0 -1px 0 var(--line), 0 -10px 30px var(--glow); padding-bottom: env(safe-area-inset-bottom); }
          .tabbar a, .tabbar button { display: grid; justify-items: center; align-content: center; gap: 2px; min-height: 58px; padding: 6px 0; border: 0; border-radius: 0; color: var(--muted); text-decoration: none; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; background: transparent; }
          .tabbar a svg, .tabbar button svg { width: 22px; height: 22px; }
          .tabbar [aria-current="page"] { color: var(--accent); }
          .tabbar [aria-current="page"]::before { content: ""; position: absolute; top: 0; width: 28px; height: 2px; background: var(--accent); }
          .tabbar > * { position: relative; }
        }
      </style>
      <div id="frame">
        <header><div class="brand"><span class="seal" id="seal"></span><h1>Juhandu</h1></div><div class="tools" id="tools"></div></header>
        <div class="rule-double"></div>
        <nav id="nav" aria-label="Sections"></nav>
        <div id="offline" role="status" hidden>You are offline. This shows what was saved on this device, and votes wait until you are back online.</div>
        <form id="add"><input id="url" type="url" placeholder="Paste a feed, a site or a YouTube channel" aria-label="Feed address" required><button class="primary" type="submit">Add</button><div id="login" class="login-row"></div></form>
        <div id="status" role="status"></div>
        <div id="ask" hidden></div>
        <div id="items"></div>
        <vz-briefing hidden></vz-briefing>
        <vz-rules hidden></vz-rules>
        <vz-feeds hidden></vz-feeds>
        <vz-pipes hidden></vz-pipes>
        <vz-connect hidden></vz-connect>
      </div>
      <nav class="tabbar" id="tabbar" aria-label="Sections"></nav>
      <dialog id="more" aria-label="More"><div class="sheet" id="sheet"></div></dialog>`;
    const frame = this.$("#frame");
    frame.classList.toggle("fx", effectsOn());

    this.$("#seal").innerHTML = SEAL; // Static markup defined in ui.js.
    this.$("#nav").append(...VIEWS.map(([name, label]) => el("a", { href: `#/${name}`, "data-view": name, text: label })));
    this.buildPhoneNav();
    const offline = this.$("#offline");
    let saved = false;
    const syncOnline = () => {
      offline.hidden = navigator.onLine && !saved;
    };
    window.addEventListener("juhandu-link", (event) => {
      saved = /** @type {CustomEvent} */ (event).detail.saved;
      syncOnline();
    });
    window.addEventListener("online", () => {
      saved = false;
      syncOnline();
      this.show();
    });
    window.addEventListener("offline", syncOnline);
    syncOnline();

    const theme = el("button", { type: "button" });
    const syncTheme = () => {
      const mode = currentTheme();
      theme.replaceChildren(icon(ICONS[mode]));
      theme.title = `Theme: ${mode}. Click to change.`;
      theme.setAttribute("aria-label", `Theme: ${mode}. Click to change.`);
    };
    theme.addEventListener("click", () => {
      applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length] ?? "system");
      syncTheme();
    });
    syncTheme();
    const effects = el("button", { type: "button", "aria-label": "Animations", title: "Animations" }, icon(ICONS.effects));
    const syncEffects = () => {
      effects.setAttribute("aria-pressed", String(effectsOn()));
      effects.title = effectsOn() ? "Animations are on. Click to turn them off." : "Animations are off. Click to turn them on.";
    };
    effects.addEventListener("click", () => {
      applyEffects(!effectsOn());
      frame.classList.toggle("fx", effectsOn());
      this.$("vz-rules").shadowRoot?.getElementById("wrap")?.classList.toggle("fx", effectsOn());
      syncEffects();
    });
    syncEffects();
    this.$("#tools").append(effects, theme);

    const form = /** @type {HTMLFormElement} */ (this.$("#add"));
    const input = /** @type {HTMLInputElement} */ (this.$("#url"));
    const status = this.$("#status");
    const picker = loginPicker({ idPrefix: "add", onKind: (kind) => {
      input.required = kind !== "url";
      input.hidden = kind === "url";
    } });
    this.$("#login").append(picker.select, picker.fields);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      status.textContent = "Looking for a feed...";
      try {
        const login = picker.read();
        const result = await api("/api/sources", { json: { ...(login?.kind === "url" ? {} : { url: input.value }), ...(login ? { login } : {}) } });
        input.value = "";
        picker.clear();
        status.textContent = result.alreadySubscribed ? "Already subscribed." : `Added with ${result.inserted} items.`;
        await this.refresh();
      } catch (error) {
        status.textContent = messageOf(error);
      }
    });
  }
}

customElements.define("vz-app", VzApp);
