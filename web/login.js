// @ts-check
// "Needs a login": the picker used by the add form and by Replace login on the Feeds screen.
// Secret fields are password inputs with autocomplete off, are only ever sent in a request body, and are cleared after saving. The server never sends them back.
import { el } from "./ui.js";

export const LOGIN_KINDS = /** @type {const} */ ([
  ["", "No login needed"],
  ["url", "Private link (the token is in the address)"],
  ["basic", "User name and password"],
  ["header", "A request header"],
  ["cookie", "A session cookie"],
]);

/** What a saved feed's lock badge says. @type {Record<string, string>} */
export const LOGIN_BADGE = { url: "private link", basic: "user name and password", header: "header", cookie: "cookie" };

/** @param {string} id @param {string} label @param {{ secret?: boolean, placeholder?: string }} [options] */
function field(id, label, options = {}) {
  const input = /** @type {HTMLInputElement} */ (
    el("input", {
      id,
      type: options.secret ? "password" : "text",
      autocomplete: options.secret ? "new-password" : "off",
      autocapitalize: "off",
      spellcheck: false,
      maxLength: 4000,
      placeholder: options.placeholder ?? "",
      "aria-label": label,
    })
  );
  return { input, row: el("label", { class: "login-field" }, el("span", { class: "muted small", text: label }), input) };
}

/**
 * @param {{ idPrefix?: string, allowed?: string[], onKind?: (kind: string) => void }} [options]
 * allowed limits the kinds offered (a saved private link can only be replaced by another private link).
 */
export function loginPicker(options = {}) {
  const prefix = options.idPrefix ?? "login";
  const allowed = options.allowed ?? LOGIN_KINDS.map(([kind]) => kind);
  const select = /** @type {HTMLSelectElement} */ (el("select", { id: `${prefix}-kind`, "aria-label": "Needs a login" }, ...LOGIN_KINDS.filter(([kind]) => allowed.includes(kind)).map(([kind, label]) => el("option", { value: kind, text: label }))));
  const link = field(`${prefix}-link`, "Private link", { secret: true, placeholder: "https://example.com/feed?token=..." });
  const user = field(`${prefix}-user`, "User name");
  const pass = field(`${prefix}-pass`, "Password", { secret: true });
  const headerName = field(`${prefix}-hname`, "Header name", { placeholder: "X-Api-Key" });
  const headerValue = field(`${prefix}-hvalue`, "Header value", { secret: true });
  const cookie = field(`${prefix}-cookie`, "Cookie", { secret: true, placeholder: "name=value; other=value" });
  const note = el("p", { class: "muted small login-note", text: "Kept in your secret store on the server and never shown again. Replace it any time from the Feeds screen." });
  const fields = el("div", { class: "login-fields" }, link.row, user.row, pass.row, headerName.row, headerValue.row, cookie.row, note);
  const groups = /** @type {Record<string, HTMLElement[]>} */ ({ url: [link.row], basic: [user.row, pass.row], header: [headerName.row, headerValue.row], cookie: [cookie.row] });
  const sync = () => {
    for (const [kind, rows] of Object.entries(groups)) for (const row of rows) row.hidden = select.value !== kind;
    note.hidden = !select.value;
    fields.hidden = !select.value;
    options.onKind?.(select.value);
  };
  select.addEventListener("change", sync);
  sync();

  return {
    kind: () => select.value,
    select,
    fields,
    /** The login object for the API, or null when none is needed. Throws a readable error when a field is empty. @returns {Record<string, string> | null} */
    read() {
      const need = (/** @type {HTMLInputElement} */ input, /** @type {string} */ what) => {
        if (!input.value.trim()) throw new Error(`${what} is required`);
        return input.value;
      };
      switch (select.value) {
        case "url":
          return { kind: "url", url: need(link.input, "The private link").trim() };
        case "basic":
          return { kind: "basic", username: need(user.input, "The user name"), password: need(pass.input, "The password") };
        case "header":
          return { kind: "header", name: need(headerName.input, "The header name").trim(), value: need(headerValue.input, "The header value") };
        case "cookie":
          return { kind: "cookie", cookie: need(cookie.input, "The cookie").trim() };
        default:
          return null;
      }
    },
    /** Empties every secret field. */
    clear() {
      for (const f of [link, user, pass, headerName, headerValue, cookie]) f.input.value = "";
    },
  };
}

export const LOGIN_STYLES = `
  .login-fields { display: grid; gap: 8px; margin-top: 8px; flex-basis: 100%; }
  .login-field { display: grid; gap: 2px; }
  .login-note { margin: 0; }
  input[type="password"] { width: 100%; min-height: 44px; padding: 8px 12px; background: var(--bg); border: 1px solid var(--line-strong); border-radius: 3px; }
`;
