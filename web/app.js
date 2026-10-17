// @ts-check
// The shell: header, navigation (Briefing, Reading, Filtered out, Rules, Feeds, Pipes), theme and effects switches, the item lists,
// the phone tab bar and the app install and offline pieces. Everything from feeds is shown as text, never as markup.
import "./briefing.js";
import "./setup.js";
import { attachPull, attachSwipe } from "./gestures.js";
import { LOGIN_STYLES, loginPicker } from "./login.js";
import { api, applyEffects, applyGestures, applyTheme, baseStyles, currentTheme, effectsOn, el, gesturesOn, initSettings, messageOf, SEAL, setBadge, THEMES, voteControls } from "./ui.js";

initSettings();

// The screens used now and then load the first time they are opened, and quietly in the background once the app is up, so the first paint
// carries only what Briefing and Reading need and the other screens are still ready the moment they are asked for.
const SCREENS = /** @type {Record<string, () => Promise<unknown>>} */ ({
  rules: () => import("./rules.js"),
  feeds: () => import("./feeds.js"),
  pipes: () => import("./pipes.js"),
  watch: () => import("./watch.js"),
  connect: () => import("./connect.js"),
});
window.addEventListener("load", () => {
  const idle = /** @type {(run: () => void) => void} */ (window.requestIdleCallback ?? ((run) => setTimeout(run, 1500)));
  idle(() => {
    for (const load of Object.values(SCREENS)) load().catch(() => {});
  });
});

// The fonts come after the first paint; the text shows in a fallback face and swaps when they arrive.
const fonts = document.createElement("link");
fonts.rel = "stylesheet";
fonts.href = "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,700;1,700&family=Alegreya+Sans:wght@400;500;700&display=swap";
document.head.append(fonts);

/** Items fetched for the first screen and for each further page while scrolling. */
const PAGE = 40;
/** How often the open app looks for new items and a new unread count, in milliseconds: every minute, or every five when the browser asks to save data. */
const WATCH_MS = /** @type {any} */ (navigator).connection?.saveData ? 300_000 : 60_000;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // The version in the address makes a new release register a new worker, even where a cache holds the old one.
    navigator.serviceWorker
      .register("/sw.js?v=__JUHANDU_VERSION__")
      .then(async (registration) => {
        // Lets an installed app refresh the count on its icon while closed, on browsers that allow it; the rest update it when opened.
        await /** @type {any} */ (registration).periodicSync?.register("juhandu-badge", { minInterval: 60 * 60 * 1000 });
      })
      .catch(() => {
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
  keys: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" stroke-linecap="round"/></svg>',
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
  ["watch", "Watch"],
  ["connect", "Connect"],
]);

class VzApp extends HTMLElement {
  /** @type {"briefing" | "reading" | "filtered" | "rules" | "feeds" | "pipes" | "watch" | "connect"} */
  view = "briefing";

  // The list on screen: the ids shown, where the next page starts, and a counter that lets a slow answer for an old list be dropped.
  /** @type {Set<number>} */
  known = new Set();
  /** @type {number | null} */
  cursor = null;
  exhausted = false;
  loadingMore = false;
  loadRun = 0;
  retryAt = 0;
  /** @type {HTMLElement | null} */
  current = null;
  /** @type {IntersectionObserver | null} */
  watcher = null;
  /** @type {(() => void) | null} */
  nearEnd = null;

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    this.takeShared();
    this.view = this.viewFromHash();
    this.render();
    window.addEventListener("hashchange", () => {
      this.view = this.viewFromHash();
      this.show();
    });
    this.bindKeys();
    this.bindPull();
    this.watchNew();
    this.show();
  }

  /** A link shared to the installed app arrives as ?url=, ?text= or ?title=; the address is put in the add box for the owner to confirm, and the query is dropped. */
  takeShared() {
    const query = new URLSearchParams(location.search);
    if (!query.has("url") && !query.has("text") && !query.has("title")) return;
    const found = [query.get("url"), query.get("text"), query.get("title")].map((value) => value?.match(/https?:\/\/\S+/)?.[0]).find(Boolean);
    this.shared = found ?? "";
    history.replaceState(null, "", `/#/reading/add`);
  }
  shared = "";

  viewFromHash() {
    const name = location.hash.replace(/^#\/?/, "").split("/")[0];
    return name === "reading" || name === "filtered" || name === "rules" || name === "feeds" || name === "pipes" || name === "watch" || name === "connect" ? name : "briefing";
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
    this.$("#more-tab").setAttribute("aria-current", this.view === "rules" || this.view === "feeds" || this.view === "pipes" || this.view === "watch" || this.view === "connect" ? "page" : "false");
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
    // A screen's code is fetched the first time it is opened (it was usually fetched in the background already), then it loads its data.
    /** @param {string} name @param {HTMLElement} element @param {(element: any) => void} [ready] */
    const open = (name, element, ready) => {
      element.hidden = this.view !== name;
      if (this.view === name) SCREENS[name]?.().then(() => ready?.(element)).catch(() => {});
    };
    open("rules", rules);
    open("feeds", feeds, (element) => element.load());
    const pipes = this.$("vz-pipes");
    open("pipes", pipes, (element) => element.load());
    const watch = this.$("vz-watch");
    open("watch", watch, (element) => element.load(location.hash.split("/")[2] ?? ""));
    const connect = this.$("vz-connect");
    open("connect", connect, (element) => element.load(location.hash.split("/")[2] ?? ""));
    const setup = this.$("vz-setup");
    setup.hidden = this.view !== "briefing" && this.view !== "reading";
    if (!setup.hidden) /** @type {any} */ (setup).load();
    if (showItems) this.refresh();
    if (this.view === "reading" && location.hash.split("/")[2] === "add") queueMicrotask(() => this.$("#url").focus());
    this.loadAsk();
    for (const shown of [briefing, items, rules, feeds, pipes, watch, connect]) {
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

  /** The first page of the list on screen. Further pages load as the end of the list comes into view. */
  async refresh() {
    const list = this.$("#items");
    const status = this.$("#status");
    const filtered = this.view === "filtered";
    const run = ++this.loadRun;
    try {
      const [{ items }, health] = await Promise.all([api(`/api/items?limit=${PAGE}&view=${filtered ? "filtered" : "inbox"}`), api("/api/health")]);
      if (run !== this.loadRun) return;
      status.textContent = filtered ? (items.length ? "Hidden by your rules. Restore anything that should not have been hidden." : "Nothing has been filtered out.") : `${health.sources} sources, ${health.items} items, ${health.unread} unread`;
      this.known = new Set(items.map((/** @type {any} */ item) => item.id));
      this.cursor = items.length ? items[items.length - 1].id : null;
      this.exhausted = items.length < PAGE;
      this.current = null;
      this.loadingMore = false;
      list.replaceChildren(...items.map((/** @type {any} */ item) => this.card(item, filtered)));
      this.$("#newpill").hidden = true;
      this.endOfList();
      setBadge(health.unread);
    } catch (error) {
      if (run === this.loadRun) status.textContent = messageOf(error);
    }
  }

  /** The next page, added below what is already shown; the page never jumps because nothing above it changes. */
  async loadMore() {
    if (this.loadingMore || this.exhausted || this.cursor === null || Date.now() < this.retryAt) return;
    if (this.view !== "reading" && this.view !== "filtered") return;
    const filtered = this.view === "filtered";
    const run = this.loadRun;
    this.loadingMore = true;
    try {
      const { items } = await api(`/api/items?limit=${PAGE}&before=${this.cursor}&view=${filtered ? "filtered" : "inbox"}`);
      if (run !== this.loadRun) return;
      const fresh = items.filter((/** @type {any} */ item) => !this.known.has(item.id));
      for (const item of items) this.known.add(item.id);
      if (items.length) this.cursor = items[items.length - 1].id;
      this.exhausted = items.length < PAGE;
      this.$("#items").append(...fresh.map((/** @type {any} */ item) => this.card(item, filtered)));
    } catch {
      // Offline or a hiccup: try again in a few seconds, when the end of the list is still in view.
      this.retryAt = Date.now() + 5_000;
    } finally {
      if (run === this.loadRun) this.loadingMore = false;
    }
    this.endOfList();
  }

  /** Keeps the end-of-list marker honest and asks the observer to look again, so a page that did not fill the screen loads the next. */
  endOfList() {
    const end = this.$("#end");
    const showing = this.view === "reading" || this.view === "filtered";
    end.hidden = !showing;
    end.textContent = this.exhausted ? (this.known.size ? "That is everything." : "") : "";
    if (!this.watcher) {
      this.watcher = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) this.loadMore();
      }, { rootMargin: "1400px 0px" });
    }
    this.watcher.unobserve(end);
    if (!this.exhausted) this.watcher.observe(end);
    if (!this.nearEnd) {
      // A browser that throttles observers (a background tab, a battery saver) still gets the next page from the scroll position.
      this.nearEnd = () => {
        if (!this.exhausted && end.getBoundingClientRect().top < innerHeight + 1400) this.loadMore();
      };
      addEventListener("scroll", this.nearEnd, { passive: true });
    }
  }

  /** While the app is open: looks for newer items and a new unread count, and offers them in a pill instead of moving the list under the reader. */
  watchNew() {
    const tick = async () => {
      if (document.hidden || !navigator.onLine) return;
      try {
        const health = await api("/api/health");
        setBadge(health.unread);
        if (this.view !== "reading") return;
        const { items } = await api("/api/items?limit=20&view=inbox");
        const fresh = items.filter((/** @type {any} */ item) => !this.known.has(item.id)).length;
        const pill = /** @type {HTMLButtonElement} */ (this.$("#newpill"));
        pill.hidden = fresh === 0;
        if (fresh > 0) pill.textContent = fresh >= 20 ? "20 or more new. Show them" : `${fresh} new. Show ${fresh === 1 ? "it" : "them"}`;
      } catch {
        // The offline note already says so.
      }
    };
    setInterval(tick, WATCH_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tick();
    });
  }

  /** Pull down from the top of Reading, Filtered or Briefing to refresh, on a phone. */
  bindPull() {
    const pull = this.$("#pull");
    attachPull({
      enabled: () => gesturesOn() && (this.view === "reading" || this.view === "filtered" || this.view === "briefing"),
      refresh: async () => {
        if (this.view === "briefing") await /** @type {any} */ (this.$("vz-briefing")).load();
        else await this.refresh();
      },
      show: (distance, ready, busy) => {
        pull.style.height = `${distance * 0.6}px`;
        pull.textContent = busy ? "Refreshing..." : distance === 0 ? "" : ready ? "Let go to refresh" : "Pull to refresh";
      },
    });
  }

  /** j and k move through the cards, l and d vote, o opens, r refreshes, when the gestures switch is on and no box has the keyboard. */
  bindKeys() {
    document.addEventListener("keydown", (event) => {
      if (!gesturesOn() || event.ctrlKey || event.metaKey || event.altKey || (this.view !== "reading" && this.view !== "filtered")) return;
      const origin = /** @type {HTMLElement | undefined} */ (event.composedPath()[0]);
      if (origin?.closest?.("input, textarea, select, dialog") || origin?.isContentEditable) return;
      const cards = this.all("#items > article");
      if (!cards.length) return;
      const at = this.current ? cards.indexOf(this.current) : -1;
      /** @param {HTMLElement | undefined} next */
      const go = (next) => {
        if (!next) return;
        this.current?.classList.remove("cur");
        this.current = next;
        next.classList.add("cur");
        next.tabIndex = -1;
        next.focus({ preventScroll: true });
        next.scrollIntoView({ block: "center", behavior: effectsOn() ? "smooth" : "auto" });
      };
      const press = (/** @type {string} */ which) => this.vote(this.current, which);
      switch (event.key) {
        case "j":
          go(cards[Math.min(at + 1, cards.length - 1)]);
          break;
        case "k":
          go(cards[Math.max(at - 1, 0)]);
          break;
        case "l":
          press("like");
          break;
        case "d":
          press("dislike");
          break;
        case "o": {
          const link = /** @type {HTMLAnchorElement | null} */ (this.current?.querySelector("a[href^='http']"));
          if (link) window.open(link.href, "_blank", "noopener,noreferrer");
          break;
        }
        case "r":
          this.refresh();
          break;
        default:
          return;
      }
      event.preventDefault();
    });
  }

  /** Presses a card's Like or Dislike unless that vote is already in; a second press would take it back. @param {HTMLElement | null} card @param {string} which */
  vote(card, which) {
    const button = /** @type {HTMLButtonElement | null | undefined} */ (card?.querySelector(`.vote-btn.${which}`));
    if (button && button.getAttribute("aria-pressed") !== "true") button.click();
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
    } else {
      attachSwipe(card, (vote) => this.vote(card, vote > 0 ? "like" : "dislike"), gesturesOn);
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
    sheet.append(el("h2", { text: "More" }), link("rules", "Rules"), link("feeds", "Feeds"), link("pipes", "Pipes"), link("watch", "Watch"), link("connect", "Connect"), el("hr"), install, clear, clearNote);
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
        .tools button[aria-pressed="true"] { color: var(--text); }
        nav { display: flex; gap: 22px; margin: 10px 0 14px; border-bottom: 1px solid var(--line); overflow-x: auto; overflow-y: hidden; }
        nav a { padding: 10px 0; color: var(--muted); text-decoration: none; letter-spacing: .06em; text-transform: uppercase; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
        nav a:hover { color: var(--text-strong); }
        nav a[aria-current="page"] { color: var(--accent); border-bottom-color: var(--accent); }
        form { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0; }
        form input { flex: 1 1 280px; width: auto; }
        .login-row { flex-basis: 100%; display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-start; }
        .login-row select { flex: 0 1 340px; width: auto; }
        .login-row input#folder { flex: 1 1 200px; }
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
        article .why { font-size: 15px; }
        article details.video { margin-top: 10px; }
        article details.video summary { cursor: pointer; color: var(--muted); min-height: 32px; display: flex; align-items: center; }
        article details.video .reading { white-space: pre-wrap; font-size: 15px; }
        article button { margin-top: 10px; }
        #items > article { content-visibility: auto; contain-intrinsic-size: auto 190px; }
        .fx article { transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease; }
        article.swiping { transition: none !important; }
        article.cur { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-dim); outline: none; }
        article[data-swipe] { border-color: var(--accent); }
        article[data-swipe="disliking"], article[data-swipe="dislike"] { border-color: var(--down); }
        article[data-swipe="like"], article[data-swipe="dislike"] { box-shadow: 0 0 0 3px var(--glow); }
        #pull { height: 0; overflow: hidden; display: grid; align-items: center; text-align: center; color: var(--muted); font-size: 13px; letter-spacing: .08em; text-transform: uppercase; }
        #newpill { position: sticky; top: 8px; z-index: 4; display: block; margin: 8px auto; box-shadow: 0 6px 24px var(--glow); }
        #end { text-align: center; color: var(--muted); font-style: italic; padding: 22px 0 8px; }
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
          .tabbar a, .tabbar button { display: grid; justify-items: center; align-content: center; gap: 2px; min-height: 58px; padding: 6px 0; border: 0; border-radius: 0; color: var(--muted); text-decoration: none; font-size: 13px; letter-spacing: .06em; text-transform: uppercase; background: transparent; }
          .tabbar a svg, .tabbar button svg { width: 22px; height: 22px; }
          .tabbar [aria-current="page"] { color: var(--accent); }
          .tabbar [aria-current="page"]::before { content: ""; position: absolute; top: 0; width: 28px; height: 2px; background: var(--accent); }
          .tabbar > * { position: relative; }
        }
      </style>
      <div id="frame">
        <div id="pull" aria-hidden="true"></div>
        <header><div class="brand"><span class="seal" id="seal"></span><h1>Juhandu</h1></div><div class="tools" id="tools"></div></header>
        <div class="rule-double"></div>
        <nav id="nav" aria-label="Sections"></nav>
        <div id="offline" role="status" hidden>You are offline. This shows what was saved on this device, and votes wait until you are back online.</div>
        <vz-setup hidden></vz-setup>
        <form id="add"><input id="url" type="url" placeholder="Paste a feed, a site or a YouTube channel" aria-label="Feed address" required><button class="primary" type="submit">Add</button><div class="login-row"><select id="tier" aria-label="Who may read this feed's text"><option value="public">Public feed (a hosted model may read it)</option><option value="private">Private feed (only local models read it)</option></select><input id="folder" type="text" maxlength="80" placeholder="Folder (optional)" aria-label="Folder"></div><div id="login" class="login-row"></div></form>
        <div id="status" role="status"></div>
        <button id="newpill" class="primary" type="button" hidden></button>
        <div id="ask" hidden></div>
        <div id="items"></div>
        <div id="end" hidden></div>
        <vz-briefing hidden></vz-briefing>
        <vz-rules hidden></vz-rules>
        <vz-feeds hidden></vz-feeds>
        <vz-pipes hidden></vz-pipes>
        <vz-watch hidden></vz-watch>
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
    const keys = el("button", { type: "button", "aria-label": "Swipe and keyboard shortcuts" }, icon(ICONS.keys));
    const syncKeys = () => {
      keys.setAttribute("aria-pressed", String(gesturesOn()));
      keys.title = gesturesOn() ? "Swipe, pull and keys are on: swipe a card right to like and left to dislike, pull down to refresh; j and k move, l likes, d dislikes, o opens, r refreshes. Click to turn them off." : "Swipe, pull and keys are off. Click to turn them on.";
    };
    keys.addEventListener("click", () => {
      applyGestures(!gesturesOn());
      syncKeys();
    });
    syncKeys();
    this.$("#newpill").addEventListener("click", () => {
      this.refresh();
      window.scrollTo({ top: 0, behavior: effectsOn() ? "smooth" : "auto" });
    });
    this.$("#tools").append(keys, effects, theme);

    const form = /** @type {HTMLFormElement} */ (this.$("#add"));
    const input = /** @type {HTMLInputElement} */ (this.$("#url"));
    if (this.shared) input.value = this.shared;
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
        const tier = /** @type {HTMLSelectElement} */ (this.$("#tier")).value;
        const folder = /** @type {HTMLInputElement} */ (this.$("#folder")).value.trim();
        const result = await api("/api/sources", { json: { ...(login?.kind === "url" ? {} : { url: input.value }), ...(login ? { login } : {}), tier, ...(folder ? { folder } : {}) } });
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
