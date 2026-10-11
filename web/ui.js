// @ts-check
// Shared pieces for the Study look: a safe element builder, the API helper, theme and effects settings, and base styles for shadow roots.
// Text from feeds and users is only ever set through textContent, never as markup.

/**
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Node | string | null | undefined | false)} children
 * @returns {HTMLElement}
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && key !== "list" && key !== "form") /** @type {any} */ (node)[key] = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** @param {string} path @param {RequestInit & { json?: unknown }} [init] */
export async function api(path, init = {}) {
  const { json, ...rest } = init;
  const options = json === undefined ? rest : { ...rest, method: rest.method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) };
  /** @type {Response} */
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    window.dispatchEvent(new CustomEvent("juhandu-link", { detail: { saved: true } }));
    throw error;
  }
  window.dispatchEvent(new CustomEvent("juhandu-link", { detail: { saved: response.headers.get("x-juhandu-saved") === "1" } }));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { status: response.status, code: body.code, place: body.place });
  return body;
}

/**
 * Like and Dislike for one item, with an optional one-line reason. A second tap on the same vote takes it back.
 * With alwaysWhy the reason box is always open and goes along with the vote (the borderline question uses that).
 * @param {{ id: number, vote?: number, voteReason?: string }} item
 * @param {{ alwaysWhy?: boolean, onVote?: (vote: number) => void }} [options]
 */
export function voteControls(item, options = {}) {
  let vote = Number(item.vote) || 0;
  const like = el("button", { type: "button", class: "vote-btn like" });
  const dislike = el("button", { type: "button", class: "vote-btn dislike" });
  like.innerHTML = THUMB; // Static markup defined in this file.
  dislike.innerHTML = THUMB;
  const note = el("span", { class: "muted small", role: "status" });
  const why = /** @type {HTMLInputElement} */ (el("input", { type: "text", maxLength: 200, placeholder: "Why? (optional, one line)", "aria-label": "Why you voted this way", value: item.voteReason ?? "" }));
  const whyRow = el("form", { class: "why-row" }, why, el("button", { type: "submit", text: options.alwaysWhy ? "Save reason" : "Save" }));
  const sync = () => {
    like.title = like.ariaLabel = vote > 0 ? "Liked. Tap to take the vote back." : "Like";
    dislike.title = dislike.ariaLabel = vote < 0 ? "Disliked. Tap to take the vote back." : "Dislike";
    like.setAttribute("aria-pressed", String(vote > 0));
    dislike.setAttribute("aria-pressed", String(vote < 0));
    whyRow.hidden = !options.alwaysWhy && vote === 0;
  };
  /** @param {number} next @param {string} reason */
  const save = async (next, reason) => {
    try {
      await api(`/api/items/${item.id}/vote`, { json: { vote: next, reason: reason.trim() } });
      vote = next;
      if (next === 0) why.value = "";
      note.textContent = next === 0 ? "Vote removed." : reason.trim() ? "Saved with your reason." : "Saved.";
      sync();
      options.onVote?.(next);
    } catch (error) {
      note.textContent = messageOf(error);
    }
  };
  like.addEventListener("click", () => save(vote > 0 ? 0 : 1, options.alwaysWhy ? why.value : ""));
  dislike.addEventListener("click", () => save(vote < 0 ? 0 : -1, options.alwaysWhy ? why.value : ""));
  whyRow.addEventListener("submit", (event) => {
    event.preventDefault();
    if (vote !== 0) save(vote, why.value);
    else note.textContent = "Like or dislike it first, then the reason is saved with it.";
  });
  sync();
  return el("div", { class: "votes" }, el("div", { class: "vote-row" }, like, dislike, note), whyRow);
}

const THUMB = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M7 11v9H4v-9h3zM9 20V10.5l3.6-6.6a1.8 1.8 0 0 1 3.4.9V9h4a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 18.8 20H9z"/></svg>';

/** The seal: a ring around a diamond, the mark of The Study. Static markup. */
export const SEAL = '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="16" cy="16" r="14"/><circle cx="16" cy="16" r="11" stroke-width=".8"/><path d="M16 7l6 9-6 9-6-9z" fill="currentColor" fill-opacity=".22"/><path d="M16 11v10M12 16h8" stroke-width=".8"/></svg>';

/** @param {unknown} error */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {string} key */
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage just forget the choice.
  }
}

export const THEMES = /** @type {const} */ (["system", "light", "dark"]);

export function currentTheme() {
  const saved = read("juhandu.theme");
  return THEMES.find((t) => t === saved) ?? "system";
}

/** @param {"system" | "light" | "dark"} theme */
export function applyTheme(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  write("juhandu.theme", theme);
  syncThemeColor();
}

/** True when the person has not chosen: then the OS "reduce motion" setting decides. */
export function effectsChosen() {
  const saved = read("juhandu.effects");
  return saved === "on" || saved === "off";
}

export function effectsOn() {
  const saved = read("juhandu.effects");
  if (saved === "on") return true;
  if (saved === "off") return false;
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** @param {boolean} on */
export function applyEffects(on) {
  document.documentElement.setAttribute("data-effects", on ? "on" : "off");
  write("juhandu.effects", on ? "on" : "off");
}

/** Swipe to vote, pull to refresh and the keyboard keys: on unless the person turned them off. */
export function gesturesOn() {
  return read("juhandu.gestures") !== "off";
}

/** @param {boolean} on */
export function applyGestures(on) {
  write("juhandu.gestures", on ? "on" : "off");
}

/** The count on the installed app's icon, where the device has one; a device without it ignores the call. @param {number} count */
export function setBadge(count) {
  const nav = /** @type {any} */ (navigator);
  try {
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.();
    done?.catch?.(() => {});
  } catch {
    // No badge on this device.
  }
}

/** Colours the phone's browser bar to match the page. */
export function syncThemeColor() {
  const color = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.append(meta);
  }
  if (color) meta.setAttribute("content", color);
}

export function initSettings() {
  applyTheme(currentTheme());
  document.documentElement.setAttribute("data-effects", effectsOn() ? "on" : "off");
  syncThemeColor();
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", syncThemeColor);
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => {
    if (!effectsChosen()) document.documentElement.setAttribute("data-effects", effectsOn() ? "on" : "off");
  });
}

/** Style rules every component shares: controls, chips, switches and the focus ring. */
export const baseStyles = `
  *, *::before, *::after { box-sizing: border-box; }
  :host { color: var(--text); font-family: var(--font-body); }
  button, input, select, textarea { font: inherit; color: inherit; }
  button { min-height: 44px; padding: 0 18px; border-radius: 3px; border: 1px solid var(--line-strong); background: transparent; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 700; }
  button.primary:hover { filter: brightness(1.08); color: var(--accent-ink); }
  button.quiet { border-color: transparent; color: var(--muted); padding: 0 12px; }
  button.quiet:hover { color: var(--accent); border-color: transparent; }
  button.danger:hover { color: var(--down); border-color: var(--down); }
  button:disabled { opacity: .5; cursor: default; }
  input[type="text"], input[type="url"], input[type="search"], input[type="password"], select, textarea { width: 100%; min-height: 44px; padding: 8px 12px; background: var(--bg); border: 1px solid var(--line-strong); border-radius: 3px; }
  textarea { resize: vertical; line-height: 1.4; }
  label.field { display: grid; gap: 6px; margin: 0 0 14px; }
  label.field > span, .legend { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  :is(button, input, select, textarea, summary, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .chip { display: inline-block; max-width: 100%; padding: 0 9px; margin: 1px 2px; border: 1px solid var(--accent-dim); border-radius: 999px; color: var(--accent); background: transparent; font-style: normal; font-size: .92em; line-height: 1.5; overflow-wrap: anywhere; vertical-align: baseline; }
  .muted { color: var(--muted); }
  .small { font-size: 15px; }
  ::placeholder { color: var(--muted); opacity: 1; font-style: italic; }
  .votes { margin-top: 10px; }
  .vote-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .vote-btn { width: 44px; min-height: 44px; height: 44px; padding: 0; border-radius: 50%; display: inline-grid; place-items: center; color: var(--muted); }
  .vote-btn.dislike svg { transform: rotate(180deg); }
  .vote-btn:hover { box-shadow: 0 0 0 3px var(--glow); }
  .vote-btn[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); background: var(--glow); }
  .vote-btn[aria-pressed="true"] svg { fill: currentColor; fill-opacity: .25; animation: pop calc(.3s * var(--t, 1)) ease; }
  .vote-btn.dislike[aria-pressed="true"] { border-color: var(--down); color: var(--down); background: transparent; }
  @keyframes pop { 40% { transform: scale(1.25); } }
  .vote-btn.dislike[aria-pressed="true"] svg { animation-name: pop-down; }
  @keyframes pop-down { 40% { transform: rotate(180deg) scale(1.25); } }
  .why-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .why-row input { flex: 1 1 220px; width: auto; }
  .switch { position: relative; width: 52px; min-height: 44px; padding: 0; border: 0; background: transparent; flex: none; }
  .switch::before { content: ""; position: absolute; left: 0; top: 11px; width: 52px; height: 22px; border-radius: 11px; border: 1px solid var(--line-strong); background: var(--bg); }
  .switch::after { content: ""; position: absolute; left: 4px; top: 15px; width: 14px; height: 14px; border-radius: 50%; background: var(--muted); }
  .switch[aria-checked="true"]::before { border-color: var(--accent); background: var(--accent); }
  .switch[aria-checked="true"]::after { left: 34px; background: var(--accent-ink); }
  .fx .switch::after { transition: left .18s ease, background .18s ease; }
  [hidden] { display: none !important; }
  input[type="range"], input[type="checkbox"] { accent-color: var(--accent); }
  input[type="range"] { width: 100%; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .rule-double { height: 4px; border-top: 1px solid var(--line-strong); border-bottom: 1px solid var(--line); margin: 0; }
  .flourish { display: flex; align-items: center; gap: 12px; color: var(--accent-dim); margin: 14px 0; }
  .flourish::before, .flourish::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, transparent, var(--line-strong)); }
  .flourish::after { transform: scaleX(-1); }
  .flourish > i { width: 7px; height: 7px; background: var(--accent); transform: rotate(45deg); flex: none; }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  .enter { animation: rise calc(.28s * var(--t, 1)) ease both; }
`;
