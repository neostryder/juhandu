// @ts-check
// The first-run checklist on Briefing and Reading. Each step reads the server's real state and links to the screen that sets it up.
// It goes away when every step is done, or for good when it is hidden.
import { api, baseStyles, el } from "./ui.js";

const STYLES = `
  :host { display: block; }
  .box { border: 1px solid var(--line-strong); border-left: 4px solid var(--accent); border-radius: 6px; padding: 12px 18px 10px; margin: 10px 0 16px; background: var(--bg-raised); }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  h2 { font-family: var(--font-display); font-style: italic; font-weight: 700; font-size: 22px; margin: 0; color: var(--accent); }
  ol { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 2px; }
  li { display: flex; align-items: center; gap: 10px; min-height: 44px; }
  .mark { flex: none; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--line-strong); display: inline-grid; place-items: center; font-size: 14px; line-height: 1; }
  li.done .mark { background: var(--accent); border-color: var(--accent); }
  li.done .mark::after { content: ""; width: 6px; height: 11px; margin-top: -3px; border: solid var(--accent-ink); border-width: 0 2px 2px 0; transform: rotate(45deg); }
  li.done .what { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--line-strong); }
  .what { flex: 1; }
  .what small { display: block; color: var(--muted); font-size: 15px; }
  a { color: var(--accent); }
`;

/** @type {{ id: "feed" | "model" | "video" | "delivery", label: string, hint: string, href: string, link: string }[]} */
const STEPS = [
  { id: "feed", label: "Add a feed", hint: "Paste a feed, a site, or a YouTube channel into the box on Reading.", href: "#/reading", link: "Go to Reading" },
  { id: "model", label: "Connect a chat model", hint: "Summaries, briefings, and suggested rules need one.", href: "#/connect/models", link: "Set up models" },
  { id: "video", label: "Set up video reading", hint: "Optional. Lets summaries say what a video says.", href: "#/connect/video", link: "Set up videos" },
  { id: "delivery", label: "Choose where the briefing goes", hint: "Optional. Email, Telegram, or Discord.", href: "#/connect/delivery", link: "Choose" },
];

class VzSetup extends HTMLElement {
  connectedCallback() {
    this.attachShadow({ mode: "open" });
  }

  async load() {
    const root = /** @type {ShadowRoot} */ (this.shadowRoot);
    /** @type {{ dismissed: boolean, steps: Record<string, boolean> }} */
    let state;
    try {
      state = await api("/api/setup");
    } catch {
      root.replaceChildren();
      return;
    }
    const left = STEPS.filter((s) => !state.steps[s.id]);
    if (state.dismissed || !left.length) {
      root.replaceChildren();
      return;
    }
    const hide = el("button", { type: "button", class: "quiet", text: "Hide this list" });
    hide.addEventListener("click", async () => {
      try {
        await api("/api/setup", { method: "PUT", json: { dismissed: true } });
      } finally {
        root.replaceChildren();
      }
    });
    const style = el("style");
    style.textContent = baseStyles + STYLES;
    root.replaceChildren(
      style,
      el(
        "section",
        { class: "box", "aria-labelledby": "setup-title" },
        el("div", { class: "head" }, el("h2", { id: "setup-title", text: "Getting started" }), el("span", { class: "muted", text: `${STEPS.length - left.length} of ${STEPS.length} done` })),
        el(
          "ol",
          {},
          ...STEPS.map((step) => {
            const done = Boolean(state.steps[step.id]);
            return el(
              "li",
              { class: done ? "done" : "" },
              el("span", { class: "mark", "aria-hidden": "true" }),
              el("span", { class: "what" }, el("span", { class: "sr", text: done ? "Done: " : "To do: " }), step.label, done ? null : el("small", { text: step.hint })),
              done ? null : el("a", { href: step.href, text: step.link }),
            );
          }),
        ),
        el("div", { class: "head" }, el("span"), hide),
      ),
    );
  }
}

customElements.define("vz-setup", VzSetup);
