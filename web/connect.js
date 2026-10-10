// @ts-check
// The Connect screen: where the daily briefing is sent (email, Telegram, Discord) and how an AI assistant reaches Juhandu (MCP).
// Secrets (the mail password, the bot token, the webhook address, the access token) are typed in once and never shown again: the server only says whether one is saved.
import { api, baseStyles, el, messageOf } from "./ui.js";

const STYLES = `
  .wrap { max-width: 860px; }
  h2 { font-family: var(--font-display); font-weight: 500; font-size: 28px; margin: 0 0 4px; }
  h3 { font-family: var(--font-display); font-weight: 500; font-size: 22px; margin: 0; }
  .lede { margin: 0 0 14px; }
  section.card { border: 1px solid var(--line); border-radius: 6px; padding: 12px 18px 16px; margin: 0 0 14px; background: var(--bg-raised); }
  section.card.on { border-left: 4px solid var(--accent); }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .top .name { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .state { font-size: 13px; padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 999px; color: var(--muted); }
  .state.ok { border-color: var(--accent-dim); color: var(--accent); }
  .state.bad { border-color: var(--down); color: var(--down); }
  .help { margin: 6px 0 12px; color: var(--muted); font-size: 15px; }
  .grid { display: grid; gap: 0 14px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
  .toggle { display: flex; align-items: center; gap: 10px; min-height: 44px; margin: 0 0 6px; }
  .toggle .text { flex: 1; }
  .toggle small { display: block; color: var(--muted); font-size: 14px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  .last { margin: 10px 0 0; font-size: 14px; color: var(--muted); overflow-wrap: anywhere; }
  .last.bad { color: var(--down); }
  code, .cmd { font-family: var(--font-mono, monospace); font-size: 14px; overflow-wrap: anywhere; }
  .cmd { display: block; padding: 8px 12px; margin: 4px 0 12px; border: 1px solid var(--line); border-radius: 3px; background: var(--bg); user-select: all; }
  .token { border: 1px solid var(--accent); border-radius: 4px; padding: 10px 12px; margin: 8px 0; background: var(--glow); }
  .token p { margin: 0 0 4px; }
  a.button { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--line-strong); border-radius: 4px; color: var(--text); text-decoration: none; }
  a.button:hover { border-color: var(--accent); }
  [hidden] { display: none !important; }
`;

/** @type {Record<string, string>} */
const SECRET_LABEL = { email: "Mail password", telegram: "Bot token", discord: "Webhook address" };
/** @type {Record<string, string>} */
const HELP = {
  email: "A message with the same briefing, as readable text and as a page with links. Use your own mail server, or an app password from your provider.",
  telegram: "Create a bot with @BotFather, paste its token here, then send your bot a message and use your chat id (a number, or @channelname for a channel the bot posts in).",
  discord: "In a server you manage: Channel settings, Integrations, Webhooks, New Webhook, then copy the address and paste it here.",
};

class VzConnect extends HTMLElement {
  /** @type {any[]} */ channels = [];
  /** @type {any} */ mcp = null;
  /** @type {string} */ freshToken = "";

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    /** @type {ShadowRoot} */ (this.shadowRoot).innerHTML = `<style>${baseStyles}${STYLES}</style>
      <div class="wrap">
        <h2>Connect</h2>
        <p class="lede muted">Send your daily briefing where you will see it, and let an AI assistant read your feeds.</p>
        <div id="status" role="status" class="muted"></div>
        <h3 id="deliveryHead">Daily briefing delivery</h3>
        <p class="help">Your briefing goes out once each morning, as soon as it is written. Items from private feeds are never sent to Telegram or Discord, and only to email if you allow it.</p>
        <div id="channels"></div>
        <div class="actions"><button id="sendNow" type="button">Send the latest briefing now</button></div>
        <div class="flourish"><i></i></div>
        <h3>AI assistants</h3>
        <p class="help">Assistants such as Claude can read your briefing and your feeds through MCP. Out of the box they can only read, and they never see private feeds.</p>
        <div id="mcp"></div>
        <div class="flourish"><i></i></div>
        <h3>Reading videos</h3>
        <p class="help">Videos in your feeds are read before they are summarized, so the summary says what the video says. Each way of reading is tried in order until one works. Private feeds never go to a hosted service.</p>
        <div id="video"></div>
        <div class="flourish"><i></i></div>
        <h3>Teach your own judge</h3>
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

  async load() {
    try {
      const [notify, mcp, training, video] = await Promise.all([api("/api/notify"), api("/api/mcp"), api("/api/training").catch(() => null), api("/api/video").catch(() => null)]);
      this.channels = notify.channels;
      this.mcp = mcp;
      this.renderChannels();
      this.renderMcp();
      this.renderVideo(video);
      this.renderTraining(training);
    } catch (error) {
      this.say(messageOf(error));
    }
  }

  renderChannels() {
    const host = this.$("channels");
    host.replaceChildren(...this.channels.map((c) => this.channelCard(c)));
    this.$("sendNow").hidden = !this.channels.length;
    this.$("deliveryHead").hidden = !this.channels.length;
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
    const secretField = el("label", { class: "field" }, el("span", { text: SECRET_LABEL[id] }), secret);
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
      const silent = this.switchRow(c.silent, "Post quietly", "No notification for people in the channel.");
      fields["silent"] = /** @type {any} */ (silent.input);
      body.push(secretField, silent.row);
    }
    const note = el("p", { class: "last", role: "status" });
    const last = channel.last;
    if (last) {
      note.textContent = last.status === "sent" ? `The last briefing went out ${new Date(last.at).toLocaleString()}.` : `${last.status === "retry" ? "The last send failed and will be tried again" : "The last send failed and was given up"}: ${last.error}`;
      note.classList.toggle("bad", last.status !== "sent");
    }
    const save = /** @type {HTMLButtonElement} */ (el("button", { type: "button", class: "primary", text: "Save" }));
    const test = /** @type {HTMLButtonElement} */ (el("button", { type: "button", text: "Send a test" }));
    const forget = el("button", { type: "button", class: "quiet danger", text: `Forget the ${(SECRET_LABEL[id] ?? "").toLowerCase()}`, hidden: !channel.secretSet });
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
      el("p", { class: "help", text: HELP[id] }),
      ...body,
      el("div", { class: "actions" }, save, test, forget),
      note,
    );
  }

  /**
   * A labelled on/off switch. The row is what gets placed; the input is the switch button, which keeps its state in aria-checked.
   * @param {boolean} on @param {string} label @param {string} hint
   */
  switchRow(on, label, hint) {
    const input = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on), "aria-label": label });
    input.addEventListener("click", () => input.setAttribute("aria-checked", String(input.getAttribute("aria-checked") !== "true")));
    const text = el("span", { class: "text" }, label, hint ? el("small", { text: hint }) : null);
    return { input, row: el("div", { class: "toggle" }, input, text) };
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

  /** @param {any} video */
  renderVideo(video) {
    const host = this.$("video");
    if (!video?.enabled) {
      host.replaceChildren(el("p", { class: "muted", text: "Reading videos is switched off on this server." }));
      return;
    }
    const done = /** @type {{ status: string, rung: string, count: number }[]} */ (video.counts);
    const read = done.filter((c) => c.status === "ok").reduce((sum, c) => sum + c.count, 0);
    const unreadable = done.filter((c) => c.status === "none").reduce((sum, c) => sum + c.count, 0);
    host.replaceChildren(
      ...video.rungs.map((/** @type {any} */ rung, /** @type {number} */ index) =>
        el(
          "section",
          { class: "card" },
          el("div", { class: "top" }, el("div", { class: "name" }, el("h3", { text: `${index + 1}. ${rung.label}` }), rung.ready ? el("span", { class: "state ok", text: "Ready" }) : el("span", { class: "state", text: "Not set up" }))),
          ...(rung.ready ? [] : [el("p", { class: "help", text: rung.reason })]),
        ),
      ),
      el("p", { class: "last", text: `${read} ${read === 1 ? "video" : "videos"} read, ${video.waiting} waiting${unreadable ? `, ${unreadable} that could not be read` : ""}.` }),
    );
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

  renderMcp() {
    const mcp = this.mcp;
    const host = this.$("mcp");
    if (!mcp?.available) {
      host.replaceChildren(el("p", { class: "muted", text: "The assistant door is not set up on this server." }));
      return;
    }
    const url = `${location.origin}/mcp`;
    const writes = this.switchRow(mcp.allowWrites, "Let assistants change things", "Voting, marking items read and writing a new briefing. Reading always works.");
    const priv = this.switchRow(mcp.includePrivate, "Let assistants see private feeds", "Their text then goes to whichever service runs the assistant.");
    const apply = async (/** @type {Record<string, any>} */ patch) => {
      try {
        await api("/api/mcp", { method: "PUT", json: patch });
        this.say("Saved.");
      } catch (error) {
        this.say(messageOf(error));
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
    host.replaceChildren(
      el("p", { class: "help", text: "For an assistant that connects over the web, give it this address:" }),
      el("code", { class: "cmd", text: url }),
      el("p", { class: "help", text: "For one that starts a program on this computer, give it this command:" }),
      el("code", { class: "cmd", text: "node src/mcp/stdio.ts" }),
      writes.row,
      priv.row,
      el("p", { class: "help", text: mcp.tokenSet ? "An access token is set: assistants must send it as a Bearer token (the program reads it from JUHANDU_MCP_TOKEN)." : "No token is set, so only programs on this computer can connect. Make one before you open Juhandu to other devices." }),
      tokenBox,
      el("div", { class: "actions" }, make, drop),
    );
  }
}

customElements.define("vz-connect", VzConnect);
