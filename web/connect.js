// @ts-check
// The Connect screen: the models Juhandu uses, how it reads videos, where the daily briefing is sent (email, Telegram, Discord), and how an
// AI assistant reaches Juhandu (MCP). Secrets (model keys, the Gemini key, the mail password, the bot token, the webhook address, the access
// token) are typed in once and never shown again: the server only says whether one is saved. A setting the server's environment fixes is
// shown read-only with the name of its variable.
import { api, baseStyles, el, messageOf } from "./ui.js";

const STYLES = `
  .wrap { max-width: 860px; }
  h2 { font-family: var(--font-display); font-weight: 500; font-size: 28px; margin: 0 0 4px; }
  h3 { font-family: var(--font-display); font-weight: 500; font-size: 22px; margin: 0; }
  h4 { font-size: 17px; margin: 14px 0 0; }
  .lede { margin: 0 0 14px; }
  section.card { border: 1px solid var(--line); border-radius: 6px; padding: 12px 18px 16px; margin: 0 0 14px; background: var(--bg-raised); }
  section.card.on { border-left: 4px solid var(--accent); }
  .sub { border-top: 1px solid var(--line); margin-top: 14px; padding-top: 4px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .top .name { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .state { font-size: 14px; padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--muted); white-space: nowrap; }
  .state.ok { border-color: var(--accent); color: var(--accent); }
  .state.bad { border-color: var(--down); color: var(--down); }
  .help { margin: 6px 0 12px; color: var(--muted); font-size: 16px; }
  .grid { display: grid; gap: 0 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .toggle { display: flex; align-items: center; gap: 10px; min-height: 44px; margin: 0 0 6px; }
  .toggle .text { flex: 1; }
  .toggle small { display: block; color: var(--muted); font-size: 15px; }
  .toggle .switch:disabled { opacity: 1; cursor: default; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .last { margin: 10px 0 0; font-size: 15px; color: var(--muted); overflow-wrap: anywhere; }
  .last.bad { color: var(--down); }
  .last.ok { color: var(--accent); }
  code, .cmd { font-family: var(--font-mono, monospace); font-size: 14px; overflow-wrap: anywhere; }
  .cmd { display: block; padding: 8px 12px; margin: 4px 0 12px; border: 1px solid var(--line); border-radius: 3px; background: var(--bg); user-select: all; }
  .token { border: 1px solid var(--accent); border-radius: 4px; padding: 10px 12px; margin: 8px 0; background: var(--glow); }
  .token p { margin: 0 0 4px; }
  .confirm { border: 1px solid var(--down); border-radius: 4px; padding: 10px 12px; margin: 10px 0 0; }
  .confirm p { margin: 0 0 8px; }
  .var { color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
  .var code { font-size: 13px; }
  .fixed { min-height: 44px; display: flex; align-items: center; padding: 0 12px; border: 1px dashed var(--line-strong); border-radius: 3px; overflow-wrap: anywhere; }
  .keyrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 44px; }
  .field-box { display: grid; gap: 6px; margin: 0 0 14px; }
  .field-box > span { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  input:disabled, select:disabled { opacity: 1; border-style: dashed; cursor: default; }
  ul.tools { margin: 6px 0 10px; padding-left: 20px; }
  a.button { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--line-strong); border-radius: 4px; color: var(--text); text-decoration: none; }
  a.button:hover { border-color: var(--accent); }
  a:not(.button) { color: var(--accent); }
  .again { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 14px; }
  .again p { margin: 0; }
  [hidden] { display: none !important; }
`;

/** @type {Record<string, string>} */
const SECRET_LABEL = { email: "Mail password", telegram: "Bot token", discord: "Webhook address" };
/** @type {Record<string, string>} */
const HELP = {
  email: "A message with the same briefing, as readable text and as a page with links. Use your own mail server, or an app password from your provider.",
  telegram: "Create a bot with @BotFather, paste its token here, then send your bot a message and use your chat id (a number, or @channelname for a channel the bot posts in).",
};
/** Discord can post to a channel through a webhook, or have a bot send one person a direct message. The label and help follow the way chosen. */
const DISCORD_WAYS = {
  webhook: {
    label: "Webhook address",
    help: "In a Discord server you manage, open the channel's settings and go to Integrations, then Webhooks, then New Webhook. Click Copy Webhook URL and paste the address here.",
    quiet: "The briefing still posts to the channel, but members get no push or desktop notification for it. On by default.",
  },
  dm: {
    label: "Bot token",
    help: "Create a bot in the Discord Developer Portal (New Application, then Bot, then Reset Token), add it to a server you are in, and paste its token here. For your user id, turn on Developer Mode in Discord, then right-click your name and choose Copy User ID. Your privacy settings for that server must allow direct messages from server members.",
    quiet: "Sends the message without a notification sound or alert. On by default.",
  },
};

/** What each model server is for, in the words the screen uses. */
/** @type {Record<string, { title: string, help: string, placeholder: string, model: string }>} */
const ENDPOINT_TEXT = {
  chat: {
    title: "Chat model",
    help: "Writes summaries and briefings, answers the yes or no questions in rules and pipes, and drafts rule suggestions.",
    placeholder: "http://127.0.0.1:8080/v1",
    model: "The name the server lists for the model.",
  },
  embed: {
    title: "Embedding model",
    help: "Turns each item into numbers so Juhandu can spot the same story from different feeds and learn what you like. Changing the model starts that work over.",
    placeholder: "http://127.0.0.1:8081/v1",
    model: "The name the server lists for the model.",
  },
  transcribe: {
    title: "Speech server",
    help: "Turns a video's sound into text. Any server with an OpenAI-style /audio/transcriptions route works, such as faster-whisper-server or whisper.cpp.",
    placeholder: "http://127.0.0.1:9000/v1",
    model: "For example whisper-1 or large-v3.",
  },
  vision: {
    title: "Vision server",
    help: "Describes still frames from a video. Any chat model that accepts images works.",
    placeholder: "http://127.0.0.1:8082/v1",
    model: "The name the server lists for the model.",
  },
};

const HOST_CHOICES = [
  ["auto", "Pick for me: Cogitator if it is installed here, otherwise the servers below"],
  ["openai", "The servers below"],
  ["cogitator", "Cogitator"],
  ["off", "No models"],
];

/**
 * The variable behind a setting, in small text under its field.
 * @param {{ from: string, variable: string }} f
 */
function varNote(f) {
  return el("small", { class: "var" }, f.from === "server" ? "Set by the server through " : "Or set ", el("code", { text: f.variable }), f.from === "server" ? ". Change it there." : " on the server.");
}

class VzConnect extends HTMLElement {
  /** @type {any[]} */ channels = [];
  /** @type {any} */ mcp = null;
  /** @type {any} */ settings = null;
  /** @type {any} */ video = null;
  /** @type {string} */ freshToken = "";
  /** Messages that outlive a reload, by card. @type {Record<string, { text: string, tone: "" | "ok" | "bad" }>} */
  notes = {};

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    /** @type {ShadowRoot} */ (this.shadowRoot).innerHTML = `<style>${baseStyles}${STYLES}</style>
      <div class="wrap">
        <h2>Connect</h2>
        <p class="lede muted">Connect the models that summarize your feeds, choose how videos are read, send your daily briefing where you will see it, and let an AI assistant read your feeds.</p>
        <div id="status" role="status" class="muted"></div>
        <div id="setupAgain" class="again" hidden></div>
        <h3 id="models-head">Models</h3>
        <p class="help">Juhandu works without a model, but summaries, briefings, and rule suggestions need a chat model, and spotting the same story in different feeds needs an embedding model. Any server that speaks the OpenAI API works, such as llama.cpp, Ollama, LM Studio, vLLM, or a hosted service.</p>
        <div id="models"></div>
        <div class="flourish"><i></i></div>
        <h3 id="video-head">Reading videos</h3>
        <p class="help">Videos in your feeds are read before they are summarized, so the summary says what the video says. Each way of reading is tried in order until one works. Videos from private feeds never go to a hosted service.</p>
        <div id="video"></div>
        <div class="flourish"><i></i></div>
        <h3 id="delivery-head">Daily briefing delivery</h3>
        <p class="help" id="deliveryHelp">Your briefing goes out once each morning, as soon as it is written. Items from private feeds are never sent to Telegram or Discord, and only to email if you allow it.</p>
        <div id="channels"></div>
        <div class="actions"><button id="sendNow" type="button">Send the latest briefing now</button></div>
        <div class="flourish"><i></i></div>
        <h3 id="assistants-head">AI assistants</h3>
        <p class="help">Assistants such as Claude can read your briefing and your feeds through MCP. You choose below whether they may change things and see private feeds.</p>
        <div id="mcp"></div>
        <div class="flourish"><i></i></div>
        <h3 id="training-head">Teach your own judge</h3>
        <p class="help">Juhandu keeps every yes or no it decides, and your votes, as practice questions for a small local model. Nothing leaves this computer when you download them. Private feeds are left out.</p>
        <div id="training"></div>
      </div>`;
    this.$("sendNow").addEventListener("click", () => this.sendNow());
  }

  /** @param {string} id */
  $(id) {
    return /** @type {HTMLElement} */ (/** @type {ShadowRoot} */ (this.shadowRoot).getElementById(id));
  }

  /** @param {string} text */
  say(text) {
    this.$("status").textContent = text;
  }

  /** @param {string} [section] Scrolls to models, video, delivery, assistants or training once the screen is drawn. */
  async load(section = "") {
    try {
      const [notify, mcp, training, video, settings, setup] = await Promise.all([
        api("/api/notify"),
        api("/api/mcp"),
        api("/api/training").catch(() => null),
        api("/api/video").catch(() => null),
        api("/api/settings").catch(() => null),
        api("/api/setup").catch(() => null),
      ]);
      this.renderSetupAgain(setup);
      this.channels = notify.channels;
      this.mcp = mcp;
      this.settings = settings;
      this.video = video;
      this.renderModels();
      this.renderVideo();
      this.renderChannels();
      this.renderMcp();
      this.renderTraining(training);
      if (section) this.$(`${section}-head`)?.scrollIntoView({ block: "start" });
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  /**
   * Offers to bring back a hidden Getting started list, while it still has steps left.
   * @param {{ dismissed: boolean, steps: Record<string, boolean> } | null} setup
   */
  renderSetupAgain(setup) {
    const host = this.$("setupAgain");
    const left = setup ? Object.values(setup.steps).filter((done) => !done).length : 0;
    if (!setup?.dismissed || !left) {
      if (!host.querySelector(".ok")) host.hidden = true;
      return;
    }
    const show = el("button", { type: "button", text: "Show the getting started list again" });
    show.addEventListener("click", async () => {
      try {
        await api("/api/setup", { method: "PUT", json: { dismissed: false } });
        host.replaceChildren(el("p", { class: "last ok", role: "status", text: "The list is back on the Briefing and Reading screens." }));
      } catch (error) {
        this.say(messageOf(error));
      }
    });
    host.replaceChildren(el("p", { class: "help", text: "The getting started list is hidden." }), show);
    host.hidden = false;
  }

  // ---- shared pieces ----

  /**
   * A note under a card that keeps its text when the screen reloads after a save.
   * @param {string} id
   */
  note(id) {
    const node = el("p", { class: "last", role: "status" });
    const saved = this.notes[id];
    /** @param {string} text @param {"" | "ok" | "bad"} [tone] */
    const set = (text, tone = "") => {
      this.notes[id] = { text, tone };
      node.textContent = text;
      node.className = `last${tone ? ` ${tone}` : ""}`;
    };
    if (saved) set(saved.text, saved.tone);
    return { node, set };
  }

  /**
   * A text field, or the server's value when its environment sets it.
   * @param {string} label @param {{ value: string, from: string, variable: string }} f @param {Record<string, any>} [extra]
   */
  textField(label, f, extra = {}) {
    if (f.from === "server") {
      return { input: null, field: el("div", { class: "field-box" }, el("span", { text: label }), el("div", { class: "fixed", text: f.value || "(empty)" }), varNote(f)) };
    }
    const input = /** @type {HTMLInputElement} */ (el("input", { type: "text", value: f.from === "default" ? "" : f.value, autocomplete: "off", spellcheck: false, ...extra }));
    return { input, field: el("label", { class: "field" }, el("span", { text: label }), input, varNote(f)) };
  }

  /**
   * A key field. A saved key shows as Saved with Replace and Remove; a key the server sets is shown as set and cannot be changed here.
   * @param {string} label @param {{ set: boolean, from: string, variable: string }} k
   */
  keyField(label, k) {
    const input = /** @type {HTMLInputElement} */ (el("input", { type: "password", autocomplete: "new-password", spellcheck: false, "aria-label": label }));
    const remove = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "quiet danger", text: "Remove" }));
    if (k.from === "server") return { input: null, remove: null, field: el("div", { class: "field-box" }, el("span", { text: label }), el("div", { class: "keyrow" }, el("span", { class: "state ok", text: "Set by the server" })), varNote(k)) };
    if (!k.set) return { input, remove: null, field: el("label", { class: "field" }, el("span", { text: label }), input, varNote(k)) };
    const replace = el("button", { type: "button", text: "Replace" });
    input.hidden = true;
    input.placeholder = "Paste the new key";
    replace.addEventListener("click", () => {
      input.hidden = false;
      replace.hidden = true;
      input.focus();
    });
    return { input, remove, field: el("div", { class: "field-box" }, el("span", { text: label }), el("div", { class: "keyrow" }, el("span", { class: "state ok", text: "Saved" }), replace, remove), input, varNote(k)) };
  }

  /**
   * A labelled on/off switch. The row is what gets placed; the input is the switch button, which keeps its state in aria-checked.
   * @param {boolean} on @param {string} label @param {string} hint @param {{ from: string, variable: string }} [f]
   */
  switchRow(on, label, hint, f) {
    const fixed = f?.from === "server";
    const input = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on), "aria-label": label, disabled: fixed });
    input.addEventListener("click", () => input.setAttribute("aria-checked", String(input.getAttribute("aria-checked") !== "true")));
    const text = el("span", { class: "text" }, label, hint ? el("small", { text: hint }) : null, f && fixed ? varNote(f) : null);
    return { input, row: el("div", { class: "toggle" }, input, text) };
  }

  /**
   * Sends a settings change. An address on this computer or a private network comes back with a question, which is shown in the card;
   * saying yes sends the same change again with the confirmation.
   * @param {string} path @param {Record<string, any>} body @param {HTMLElement} confirmHost @param {(text: string, tone?: "" | "ok" | "bad") => void} say
   * @returns {Promise<boolean>} true when the change was saved
   */
  async putSettings(path, body, confirmHost, say) {
    try {
      await api(path, { method: "PUT", json: body });
      confirmHost.replaceChildren();
      return true;
    } catch (error) {
      const code = /** @type {any} */ (error).code;
      if (code !== "confirm-address") {
        say(messageOf(error), "bad");
        return false;
      }
      return new Promise((resolve) => {
        const yes = el("button", { type: "button", class: "primary", text: "Yes, it is mine. Save it." });
        const no = el("button", { type: "button", class: "quiet", text: "Cancel" });
        yes.addEventListener("click", async () => resolve(await this.putSettings(path, { ...body, confirmAddress: true }, confirmHost, say)));
        no.addEventListener("click", () => {
          confirmHost.replaceChildren();
          say("Nothing was saved.");
          resolve(false);
        });
        confirmHost.replaceChildren(el("div", { class: "confirm", role: "alert" }, el("p", { text: messageOf(error) }), el("div", { class: "actions" }, yes, no)));
        yes.focus();
      });
    }
  }

  /**
   * Runs a Test button and shows what it found.
   * @param {string} path @param {(text: string, tone?: "" | "ok" | "bad") => void} say
   */
  async runTest(path, say) {
    say("Testing...");
    try {
      const result = await api(path, { json: {} });
      say(result.message, result.ok ? "ok" : "bad");
    } catch (error) {
      say(messageOf(error), "bad");
    }
  }

  // ---- models ----

  renderModels() {
    const host = this.$("models");
    const s = this.settings;
    if (!s) {
      host.replaceChildren(el("p", { class: "muted", text: "Model settings are not available on this server." }));
      return;
    }
    const select = /** @type {HTMLSelectElement} */ (el("select", { disabled: s.host.from === "server", "aria-label": "Where models come from" }, ...HOST_CHOICES.map(([value, text]) => el("option", { value, text }))));
    select.value = s.host.value;
    const using = { openai: "the servers below", cogitator: "Cogitator", off: "no model yet" }[/** @type {"openai" | "cogitator" | "off"} */ (s.host.active)];
    const hostNote = this.note("host");
    const confirm = el("div");
    select.addEventListener("change", async () => {
      if (await this.putSettings("/api/settings/host", { host: select.value }, confirm, hostNote.set)) {
        hostNote.set("Saved.", "ok");
        await this.load();
      }
    });
    const choice = s.host.value;
    const showServers = choice === "openai" || (choice === "auto" && s.host.active !== "cogitator");
    const showCogitator = choice === "cogitator" || (choice === "auto" && s.host.active === "cogitator");
    const byId = (/** @type {string} */ id) => s.endpoints.find((/** @type {any} */ e) => e.id === id);
    host.replaceChildren(
      el("label", { class: "field" }, el("span", { text: "Where models come from" }), select, varNote(s.host)),
      el("p", { class: "last", text: `Right now Juhandu uses ${using}.${choice === "auto" && s.host.active === "cogitator" ? " Cogitator was found on this computer." : ""}` }),
      confirm,
      hostNote.node,
      ...(showServers ? [this.endpointCard(byId("chat"), "section"), this.endpointCard(byId("embed"), "section")] : []),
      ...(showCogitator ? [this.cogitatorCard()] : []),
    );
  }

  /**
   * The card for one OpenAI-style server: address, model, key, the private-feed switch, Save and Test.
   * @param {any} ep @param {"section" | "div"} shape
   */
  endpointCard(ep, shape) {
    const text = ENDPOINT_TEXT[ep.id] ?? { title: ep.id, help: "", placeholder: "", model: "" };
    const url = this.textField("Address", ep.url, { type: "url", placeholder: text.placeholder, inputMode: "url" });
    const model = this.textField("Model name", ep.model, { placeholder: ep.model.from === "default" ? ep.model.value : "" });
    const key = this.keyField("Key (only if the server needs one)", ep.key);
    const local = this.switchRow(ep.local.value, "Send items from private feeds here", "Only for a server you run yourself. Items from private feeds never go to any other server.", ep.local);
    let localTouched = false;
    local.input.addEventListener("click", () => (localTouched = true));
    const note = this.note(ep.id);
    const confirm = el("div");
    const save = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "primary", text: "Save" }));
    const test = /** @type {HTMLButtonElement} */ (el("button", { type: "button", text: "Test" }));
    const initial = { url: url.input?.value ?? "", model: model.input?.value ?? "" };
    const changes = () => {
      /** @type {Record<string, any>} */
      const out = {};
      if (url.input && url.input.value.trim() !== initial.url) out["url"] = url.input.value.trim() || null;
      if (model.input && model.input.value.trim() !== initial.model) out["model"] = model.input.value.trim() || null;
      if (localTouched) out["local"] = local.input.getAttribute("aria-checked") === "true";
      if (key.input && key.input.value.trim()) out["key"] = key.input.value.trim();
      return out;
    };
    const path = `/api/settings/endpoints/${ep.id}`;
    const busy = async (/** @type {() => Promise<void>} */ work) => {
      save.disabled = test.disabled = true;
      try {
        await work();
      } finally {
        save.disabled = test.disabled = false;
      }
    };
    /** Saves what changed. Returns false when nothing could be saved. */
    const store = async () => {
      const body = changes();
      if (!Object.keys(body).length) return true;
      if (!(await this.putSettings(path, body, confirm, note.set))) return false;
      note.set(`${text.title} saved.`, "ok");
      return true;
    };
    save.addEventListener("click", () =>
      busy(async () => {
        if (!Object.keys(changes()).length) return note.set("Nothing has changed.");
        if (await store()) await this.load();
      }),
    );
    test.addEventListener("click", () =>
      busy(async () => {
        const dirty = Object.keys(changes()).length > 0;
        if (!(await store())) return;
        await this.runTest(`${path}/test`, note.set);
        if (dirty) await this.load();
      }),
    );
    key.remove?.addEventListener("click", () =>
      busy(async () => {
        if (await this.putSettings(path, { key: null }, confirm, note.set)) {
          note.set("The key was removed.");
          await this.load();
        }
      }),
    );
    const state = ep.url.value ? el("span", { class: "state ok", text: "Set up" }) : el("span", { class: "state", text: "Not set up" });
    const head = shape === "section" ? el("h3", { text: text.title }) : el("h4", { text: text.title });
    return el(
      shape,
      { class: shape === "section" ? `card${ep.url.value ? " on" : ""}` : "sub" },
      el("div", { class: "top" }, el("div", { class: "name" }, head, state)),
      el("p", { class: "help", text: text.help }),
      el("div", { class: "grid" }, url.field, model.field),
      key.field,
      local.row,
      el("div", { class: "actions" }, save, test),
      confirm,
      note.node,
    );
  }

  cogitatorCard() {
    const c = this.settings.cogitator;
    const url = this.textField("Address (only if Cogitator runs on another computer)", c.url, { type: "url", placeholder: "http://192.168.1.10:7860", inputMode: "url" });
    const interactive = this.keyField("Key for work you wait on", c.interactiveKey);
    const background = this.keyField("Key for background work", c.backgroundKey);
    const note = this.note("cogitator");
    const confirm = el("div");
    const save = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "primary", text: "Save" }));
    const test = /** @type {HTMLButtonElement} */ (el("button", { type: "button", text: "Test" }));
    const initial = url.input?.value ?? "";
    const changes = () => {
      /** @type {Record<string, any>} */
      const out = {};
      if (url.input && url.input.value.trim() !== initial) out["cogitatorUrl"] = url.input.value.trim() || null;
      if (interactive.input?.value.trim()) out["interactiveKey"] = interactive.input.value.trim();
      if (background.input?.value.trim()) out["backgroundKey"] = background.input.value.trim();
      return out;
    };
    const store = async () => {
      const body = changes();
      if (!Object.keys(body).length) return true;
      if (!(await this.putSettings("/api/settings/host", body, confirm, note.set))) return false;
      note.set("Cogitator saved.", "ok");
      return true;
    };
    save.addEventListener("click", async () => {
      if (!Object.keys(changes()).length) return note.set("Nothing has changed.");
      if (await store()) await this.load();
    });
    test.addEventListener("click", async () => {
      const dirty = Object.keys(changes()).length > 0;
      if (!(await store())) return;
      await this.runTest("/api/settings/host/test", note.set);
      if (dirty) await this.load();
    });
    for (const [k, name] of /** @type {const} */ ([[interactive, "interactiveKey"], [background, "backgroundKey"]])) {
      k.remove?.addEventListener("click", async () => {
        if (await this.putSettings("/api/settings/host", { [name]: null }, confirm, note.set)) {
          note.set("The key was removed.");
          await this.load();
        }
      });
    }
    return el(
      "section",
      { class: "card on" },
      el("div", { class: "top" }, el("div", { class: "name" }, el("h3", { text: "Cogitator" }), el("span", { class: this.settings.host.cogitatorFound ? "state ok" : "state", text: this.settings.host.cogitatorFound ? "Found" : "Not found" }))),
      el("p", { class: "help", text: "Cogitator runs and routes local models for you. On this computer, Juhandu finds it by itself. On another computer, add its address and the two keys it made for Juhandu." }),
      url.field,
      el("div", { class: "grid" }, interactive.field, background.field),
      el("div", { class: "actions" }, save, test),
      confirm,
      note.node,
    );
  }

  // ---- videos ----

  renderVideo() {
    const host = this.$("video");
    const s = this.settings;
    const video = this.video;
    if (!s) {
      host.replaceChildren(el("p", { class: "muted", text: video?.enabled ? "Video settings are not available on this server." : "Reading videos is switched off on this server." }));
      return;
    }
    const master = this.switchRow(s.video.enabled.value, "Read videos", "When this is off, videos are summarized from their title and description only.", s.video.enabled);
    const masterNote = this.note("video");
    master.input.addEventListener("click", async () => {
      if (await this.putSettings("/api/settings/video", { enabled: master.input.getAttribute("aria-checked") === "true" }, el("div"), masterNote.set)) await this.load();
    });
    if (!s.video.enabled.value) {
      host.replaceChildren(master.row, masterNote.node);
      return;
    }
    /** @type {Record<string, any>} */
    const rungs = Object.fromEntries((video?.rungs ?? []).map((/** @type {any} */ r) => [r.id, r]));
    const pill = (/** @type {any} */ rung) => (rung?.ready ? el("span", { class: "state ok", text: "Ready" }) : el("span", { class: "state", text: "Not set up" }));
    const reason = (/** @type {any} */ rung) => (rung && !rung.ready ? el("p", { class: "last", text: rung.reason }) : null);
    const done = /** @type {{ status: string, rung: string, count: number }[]} */ (video?.counts ?? []);
    const read = done.filter((c) => c.status === "ok").reduce((sum, c) => sum + c.count, 0);
    const unreadable = done.filter((c) => c.status === "none").reduce((sum, c) => sum + c.count, 0);
    const byId = (/** @type {string} */ id) => s.endpoints.find((/** @type {any} */ e) => e.id === id);
    host.replaceChildren(
      master.row,
      masterNote.node,
      this.toolsNote(),
      this.geminiCard(rungs["gemini"]),
      el(
        "section",
        { class: `card${rungs["captions"]?.ready ? " on" : ""}` },
        el("div", { class: "top" }, el("div", { class: "name" }, el("h3", { text: "2. The video's own captions" }), pill(rungs["captions"]))),
        el("p", { class: "help", text: "yt-dlp fetches the captions a video already has. With a chat model connected, they are tidied into a short reading; without one, the start of the captions is kept as it is. This needs nothing set up beyond yt-dlp." }),
        reason(rungs["captions"]),
      ),
      el(
        "section",
        { class: `card${rungs["local"]?.ready ? " on" : ""}` },
        el("div", { class: "top" }, el("div", { class: "name" }, el("h3", { text: "3. Speech and frames, read on your own servers" }), pill(rungs["local"]))),
        el("p", { class: "help", text: "For a video with no captions, Juhandu downloads it with yt-dlp, cuts out the sound and a few frames with ffmpeg, and sends them to your speech and vision servers. Either server is enough." }),
        reason(rungs["local"]),
        this.endpointCard(byId("transcribe"), "div"),
        this.endpointCard(byId("vision"), "div"),
      ),
      el("p", { class: "last", text: video ? `${read} ${read === 1 ? "video" : "videos"} read, ${video.waiting} waiting${unreadable ? `, ${unreadable} that could not be read` : ""}.` : "" }),
    );
  }

  /** Says plainly which outside programs are missing and how to add them. */
  toolsNote() {
    const t = this.settings.video.tools;
    if (t.ytdlp && t.ffmpeg) return el("p", { class: "last", text: "yt-dlp and ffmpeg are installed on the server." });
    const missing = [!t.ytdlp ? "yt-dlp" : "", !t.ffmpeg ? "ffmpeg" : ""].filter(Boolean);
    const what = !t.ytdlp ? "Without yt-dlp, only Gemini can read videos." : "Without ffmpeg, videos with no captions cannot be read on your own servers.";
    /** @type {(HTMLElement | string)[]} */
    const steps = t.container
      ? [
          el("p", { class: "help", text: "This server runs in Docker. Rebuild its image with both programs, then start it again:" }),
          el("code", { class: "cmd", text: "docker compose build --build-arg VIDEO_TOOLS=full" }),
          el("code", { class: "cmd", text: "docker compose up -d" }),
        ]
      : [
          el("p", { class: "help", text: `Install ${missing.join(" and ")} on the computer that runs Juhandu so that ${missing.length > 1 ? "they are" : "it is"} on the PATH, or name the program file with JUHANDU_YTDLP or JUHANDU_FFMPEG. Juhandu looks again within ten minutes.` }),
        ];
    return el(
      "section",
      { class: "card" },
      el("div", { class: "top" }, el("div", { class: "name" }, el("h3", { text: "Programs on the server" }), el("span", { class: "state bad", text: `${missing.join(" and ")} missing` }))),
      el("ul", { class: "tools" }, el("li", { text: `yt-dlp: ${t.ytdlp ? "installed" : "not installed"}` }), el("li", { text: `ffmpeg: ${t.ffmpeg ? "installed" : "not installed"}` })),
      el("p", { class: "help", text: what }),
      ...steps,
    );
  }

  /** @param {any} rung */
  geminiCard(rung) {
    const v = this.settings.video;
    const use = this.switchRow(v.gemini.value, "Use Gemini", "Only public videos go to Google. Videos from private feeds never do.", v.gemini);
    let useTouched = false;
    use.input.addEventListener("click", () => (useTouched = true));
    const key = this.keyField("Gemini API key", v.geminiKey);
    const note = this.note("gemini");
    const confirm = el("div");
    const save = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "primary", text: "Save" }));
    const test = /** @type {HTMLButtonElement} */ (el("button", { type: "button", text: "Test" }));
    const changes = () => {
      /** @type {Record<string, any>} */
      const out = {};
      if (useTouched) out["gemini"] = use.input.getAttribute("aria-checked") === "true";
      if (key.input?.value.trim()) out["geminiKey"] = key.input.value.trim();
      return out;
    };
    const store = async () => {
      const body = changes();
      if (!Object.keys(body).length) return true;
      if (!(await this.putSettings("/api/settings/video", body, confirm, note.set))) return false;
      note.set("Gemini saved.", "ok");
      return true;
    };
    save.addEventListener("click", async () => {
      if (!Object.keys(changes()).length) return note.set("Nothing has changed.");
      if (await store()) await this.load();
    });
    test.addEventListener("click", async () => {
      if (!(await store())) return;
      await this.runTest("/api/settings/video/gemini/test", note.set);
      // The badge follows the result, so the card is drawn again.
      await this.load();
    });
    key.remove?.addEventListener("click", async () => {
      if (await this.putSettings("/api/settings/video", { geminiKey: null }, confirm, note.set)) {
        note.set("The key was removed.");
        await this.load();
      }
    });
    const link = el("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener noreferrer", text: "Google AI Studio" });
    // A failed Test outranks Ready: the badge says so until a Test passes or the key changes, and the note under the buttons says why.
    const badge = rung?.failed
      ? el("span", { class: "state bad", text: "Test failed" })
      : rung?.ready
        ? el("span", { class: "state ok", text: "Ready" })
        : el("span", { class: "state", text: "Not set up" });
    if (rung?.failed && !this.notes["gemini"]) note.set(rung.reason, "bad");
    return el(
      "section",
      { class: `card${rung?.ready ? " on" : ""}` },
      el("div", { class: "top" }, el("div", { class: "name" }, el("h3", { text: "1. Gemini reads the video" }), badge)),
      el("p", { class: "help" }, "Google's Gemini watches a public video from its address, so nothing is downloaded here. Make a key in ", link, " and paste it below."),
      rung && !rung.ready && !rung.failed ? el("p", { class: "last", text: rung.reason }) : null,
      use.row,
      key.field,
      el("div", { class: "actions" }, save, test),
      confirm,
      note.node,
    );
  }

  // ---- delivery ----

  renderChannels() {
    const host = this.$("channels");
    host.replaceChildren(...this.channels.map((c) => this.channelCard(c)));
    this.$("sendNow").hidden = !this.channels.length;
    this.$("delivery-head").hidden = !this.channels.length;
    this.$("deliveryHelp").hidden = !this.channels.length;
  }

  /** @param {any} channel */
  channelCard(channel) {
    const c = channel.config;
    const id = channel.id;
    const state = c.enabled ? (channel.ready ? el("span", { class: "state ok", text: "On" }) : el("span", { class: "state bad", text: `Needs ${channel.missing[0]}` })) : el("span", { class: "state", text: "Off" });
    /** @type {Record<string, any>} */
    const fields = {};
    /** @param {string} key @param {string} label @param {string} value @param {Record<string, any>} [extra] */
    const field = (key, label, value, extra = {}) => {
      const input = el("input", { type: "text", value, autocomplete: "off", spellcheck: false, ...extra });
      fields[key] = /** @type {HTMLInputElement} */ (input);
      return el("label", { class: "field" }, el("span", { text: label }), input);
    };
    const secret = /** @type {HTMLInputElement} */ (el("input", { type: "password", autocomplete: "new-password", placeholder: channel.secretSet ? "Saved. Type to replace it." : "", spellcheck: false }));
    const helpText = el("p", { class: "help", text: id === "discord" ? DISCORD_WAYS[c.mode === "dm" ? "dm" : "webhook"].help : HELP[id] });
    const secretLabel = el("span", { text: id === "discord" ? DISCORD_WAYS[c.mode === "dm" ? "dm" : "webhook"].label : SECRET_LABEL[id] });
    const secretField = el("label", { class: "field" }, secretLabel, secret);
    const enabled = this.switchRow(c.enabled, `Send the briefing to ${channel.label}`, "");
    /** @type {HTMLElement[]} */
    const body = [];
    if (id === "email") {
      const security = el("select", {}, el("option", { value: "starttls", text: "STARTTLS (port 587)" }), el("option", { value: "tls", text: "TLS (port 465)" }), el("option", { value: "none", text: "None (this machine only)" }));
      /** @type {HTMLSelectElement} */ (security).value = c.security;
      fields["security"] = /** @type {HTMLSelectElement} */ (security);
      const includePrivate = this.switchRow(c.includePrivate, "Include items from private feeds", "Email goes to your own mail server, so this is your call. Off by default.");
      fields["includePrivate"] = /** @type {any} */ (includePrivate.input);
      body.push(
        el("div", { class: "grid" }, field("host", "Mail server", c.host, { placeholder: "smtp.example.com" }), field("port", "Port", String(c.port), { inputMode: "numeric" }), el("label", { class: "field" }, el("span", { text: "Security" }), security)),
        el("div", { class: "grid" }, field("user", "Login name (if the server needs one)", c.user), secretField),
        el("div", { class: "grid" }, field("from", "From", c.from, { placeholder: "juhandu@example.com" }), field("to", "To (one or more, separated by commas)", c.to.join(", "), { placeholder: "you@example.com" })),
        includePrivate.row,
      );
    } else if (id === "telegram") {
      const silent = this.switchRow(c.silent, "Deliver quietly", "No sound or buzz on your phone.");
      fields["silent"] = /** @type {any} */ (silent.input);
      body.push(el("div", { class: "grid" }, secretField, field("chatId", "Chat id", c.chatId, { placeholder: "123456789" })), silent.row);
    } else {
      const way = c.mode === "dm" ? "dm" : "webhook";
      const mode = el("select", {}, el("option", { value: "webhook", text: "Post to a channel (webhook)" }), el("option", { value: "dm", text: "Send me a direct message (bot)" }));
      /** @type {HTMLSelectElement} */ (mode).value = way;
      fields["mode"] = /** @type {HTMLSelectElement} */ (mode);
      const userId = field("userId", "Your Discord user id", c.userId ?? "", { placeholder: "123456789012345678", inputMode: "numeric" });
      const silent = this.switchRow(c.silent, "Send quietly", DISCORD_WAYS[way].quiet);
      fields["silent"] = /** @type {any} */ (silent.input);
      const quiet = silent.row.querySelector("small");
      const showWay = (/** @type {"webhook" | "dm"} */ next) => {
        secretLabel.textContent = DISCORD_WAYS[next].label;
        secret.placeholder = channel.secretsSet?.[next] ? "Saved. Type to replace it." : "";
        userId.hidden = next !== "dm";
        helpText.textContent = DISCORD_WAYS[next].help;
        if (quiet) quiet.textContent = DISCORD_WAYS[next].quiet;
      };
      mode.addEventListener("change", () => showWay(/** @type {HTMLSelectElement} */ (mode).value === "dm" ? "dm" : "webhook"));
      userId.hidden = way !== "dm";
      body.push(el("label", { class: "field" }, el("span", { text: "How Discord reaches you" }), mode), el("div", { class: "grid" }, secretField, userId), silent.row);
    }
    const note = el("p", { class: "last", role: "status" });
    const last = channel.last;
    if (last) {
      note.textContent = last.status === "sent" ? `The last briefing went out ${new Date(last.at).toLocaleString()}.` : `${last.status === "retry" ? "The last send failed and will be tried again" : "The last send failed and was given up"}: ${last.error}`;
      note.classList.toggle("bad", last.status !== "sent");
    }
    const save = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "primary", text: "Save" }));
    const test = /** @type {HTMLButtonElement} */ (el("button", { type: "button", text: "Send a test" }));
    const forgetLabel = id === "discord" ? DISCORD_WAYS[c.mode === "dm" ? "dm" : "webhook"].label : SECRET_LABEL[id] ?? "";
    const forget = el("button", { type: "button", class: "quiet danger", text: `Forget the ${forgetLabel.toLowerCase()}`, hidden: !channel.secretSet });
    const busy = async (/** @type {() => Promise<void>} */ work) => {
      save.disabled = test.disabled = true;
      try {
        await work();
      } catch (error) {
        note.textContent = messageOf(error);
        note.classList.add("bad");
      } finally {
        save.disabled = test.disabled = false;
      }
    };
    const patch = () => {
      /** @type {Record<string, any>} */
      const out = { enabled: enabled.input.getAttribute("aria-checked") === "true" };
      for (const [key, input] of Object.entries(fields)) {
        if (input.getAttribute("role") === "switch") out[key] = input.getAttribute("aria-checked") === "true";
        else if (key === "port") out[key] = Number(input.value);
        else out[key] = input.value;
      }
      return out;
    };
    save.addEventListener("click", () =>
      busy(async () => {
        const typed = secret.value.trim();
        await api(`/api/notify/${id}`, { method: "PUT", json: { ...patch(), ...(typed ? { secret: typed } : {}) } });
        secret.value = "";
        await this.load();
        this.say(`${channel.label} saved.`);
      }),
    );
    test.addEventListener("click", () =>
      busy(async () => {
        note.classList.remove("bad");
        note.textContent = "Sending a test...";
        await api(`/api/notify/${id}/test`, { method: "POST", json: {} });
        note.textContent = "The test went out. Check that it arrived.";
      }),
    );
    forget.addEventListener("click", () =>
      busy(async () => {
        await api(`/api/notify/${id}`, { method: "PUT", json: { enabled: false, secret: null } });
        await this.load();
      }),
    );
    return el(
      "section",
      { class: `card${c.enabled ? " on" : ""}` },
      el("div", { class: "top" }, el("div", { class: "name" }, el("h3", { text: channel.label }), state), enabled.row),
      helpText,
      ...body,
      el("div", { class: "actions" }, save, test, forget),
      note,
    );
  }

  async sendNow() {
    const button = /** @type {HTMLButtonElement} */ (this.$("sendNow"));
    button.disabled = true;
    this.say("Sending...");
    try {
      const { results } = await api("/api/notify/send", { json: {} });
      this.say(results.length ? results.map((/** @type {any} */ r) => `${r.channel}: ${r.result === "sent" ? "sent" : r.detail}`).join(". ") + "." : "Nothing is switched on yet.");
      await this.load();
    } catch (error) {
      this.say(messageOf(error));
    } finally {
      button.disabled = false;
    }
  }

  /** @param {any} training */
  renderTraining(training) {
    const host = this.$("training");
    if (!training) {
      host.replaceChildren(el("p", { class: "muted", text: "Training data is not available on this server." }));
      return;
    }
    host.replaceChildren(
      ...training.lanes.map((/** @type {any} */ lane) => {
        const taught = lane.human ? `${lane.human} from your votes` : "";
        const jev = lane.teacher ? `${lane.teacher} taught by Jev` : "";
        const have = [taught, jev].filter(Boolean).join(", ") || "No practice questions yet";
        const state = lane.ready ? el("span", { class: "state ok", text: "Enough to train" }) : el("span", { class: "state", text: lane.human ? `Needs ${training.minHumanTrain} on the training side` : "Not yet" });
        const link = el("a", { class: "button", href: `/api/training/export?lane=${lane.lane}`, download: `juhandu-${lane.lane}.jsonl`, text: "Download practice questions" });
        return el(
          "section",
          { class: "card" },
          el("div", { class: "top" }, el("div", { class: "name" }, el("h3", { text: lane.title }), state), link),
          el("p", { class: "help", text: `${lane.note} ${have}.` }),
        );
      }),
    );
  }

  // ---- assistants ----

  renderMcp() {
    const mcp = this.mcp;
    const host = this.$("mcp");
    if (!mcp?.available) {
      host.replaceChildren(el("p", { class: "muted", text: "The assistant door is not set up on this server." }));
      return;
    }
    const url = `${location.origin}/mcp`;
    const writes = this.switchRow(mcp.allowWrites, "Let assistants change things", "Voting, marking items read, and writing a new briefing. Reading always works.");
    const priv = this.switchRow(mcp.includePrivate, "Let assistants see private feeds", "Their text then goes to whichever service runs the assistant.");
    const now = el("p", { class: "last", role: "status" });
    const describe = () => {
      const canWrite = writes.input.getAttribute("aria-checked") === "true";
      const seePrivate = priv.input.getAttribute("aria-checked") === "true";
      now.textContent = `Right now assistants can ${canWrite ? "read and change things" : "only read"}, and they ${seePrivate ? "can see" : "never see"} private feeds.`;
    };
    describe();
    const apply = async (/** @type {Record<string, any>} */ patch) => {
      try {
        this.mcp = { ...this.mcp, ...(await api("/api/mcp", { method: "PUT", json: patch })) };
        describe();
      } catch (error) {
        now.textContent = messageOf(error);
      }
    };
    writes.input.addEventListener("click", () => apply({ allowWrites: writes.input.getAttribute("aria-checked") === "true" }));
    priv.input.addEventListener("click", () => apply({ includePrivate: priv.input.getAttribute("aria-checked") === "true" }));
    const tokenBox = el("div", { class: "token", hidden: !this.freshToken });
    const showToken = () => {
      tokenBox.replaceChildren(el("p", { text: "Copy this token now. It is not shown again." }), el("code", { text: this.freshToken }));
      tokenBox.hidden = !this.freshToken;
    };
    showToken();
    const make = el("button", { type: "button", text: mcp.tokenSet ? "Make a new token" : "Make an access token" });
    make.addEventListener("click", async () => {
      try {
        const out = await api("/api/mcp", { method: "PUT", json: { token: "new" } });
        this.freshToken = out.token;
        this.mcp = out;
        this.renderMcp();
      } catch (error) {
        this.say(messageOf(error));
      }
    });
    const drop = el("button", { type: "button", class: "quiet danger", text: "Remove the token", hidden: !mcp.tokenSet });
    drop.addEventListener("click", async () => {
      try {
        this.freshToken = "";
        this.mcp = await api("/api/mcp", { method: "PUT", json: { token: null } });
        this.renderMcp();
      } catch (error) {
        this.say(messageOf(error));
      }
    });
    const tokenText = mcp.tokenSet
      ? "An access token is set, so every assistant must send it as a Bearer token (the program reads it from JUHANDU_MCP_TOKEN)."
      : mcp.proxied
        ? "No token is set, so only programs on the computer that runs Juhandu can connect. You are reaching Juhandu through a proxy, so an assistant on this device needs a token too."
        : "No token is set, so only programs on this computer can connect. Requests through a proxy or a public address are refused. Make a token before an assistant on another device connects.";
    host.replaceChildren(
      writes.row,
      priv.row,
      now,
      el("p", { class: "help", text: "For an assistant that connects over the web, give it this address:" }),
      el("code", { class: "cmd", text: url }),
      el("p", { class: "help", text: "For one that starts a program on this computer, give it this command:" }),
      el("code", { class: "cmd", text: "node src/mcp/stdio.ts" }),
      el("p", { class: "help", text: tokenText }),
      tokenBox,
      el("div", { class: "actions" }, make, drop),
    );
  }
}

customElements.define("vz-connect", VzConnect);
