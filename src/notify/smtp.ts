// A small SMTP client for sending one message. It speaks implicit TLS (port 465), STARTTLS (587) or plain text,
// logs in with AUTH PLAIN or LOGIN, and refuses to send a password over an unencrypted link to anything but this machine.
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

export interface MailServer {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  user?: string;
  password?: string;
  /** The name this client gives in EHLO. */
  helo?: string;
  timeoutMs?: number;
  /** Extra TLS options, used by tests to trust a throwaway certificate. */
  tlsOptions?: tls.ConnectionOptions;
}

export interface Mail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

export class SmtpError extends Error {}

const ADDRESS = /^[^\s<>@,;"()[\]\\]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export function validAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS.test(address);
}

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);

interface Reply {
  code: number;
  lines: string[];
}

/** Reads the server's replies one at a time from a socket. A reply can span several lines; the last has a space after the code. */
class Conn {
  socket: net.Socket;
  private buffer = "";
  private replies: Reply[] = [];
  private pending: Reply["lines"] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at).replace(/\r$/, "");
        this.buffer = this.buffer.slice(at + 1);
        this.pending.push(line);
        if (/^\d{3}( |$)/.test(line)) {
          this.replies.push({ code: Number(line.slice(0, 3)), lines: this.pending });
          this.pending = [];
        }
      }
      this.deliver();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new SmtpError("The mail server closed the connection")));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.deliver();
  }

  private deliver(): void {
    if (!this.waiter) return;
    const reply = this.replies.shift();
    if (reply) {
      const { resolve } = this.waiter;
      this.waiter = null;
      resolve(reply);
    } else if (this.failure) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(this.failure);
    }
  }

  read(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.deliver();
    });
  }

  write(data: string): void {
    this.socket.write(data);
  }

  /** Sends a command and reads the reply, which must start with one of the expected first digits or codes. */
  async command(line: string, ok: number[]): Promise<Reply> {
    this.write(line + "\r\n");
    return this.expect(ok, line.split(" ")[0] ?? line);
  }

  async expect(ok: number[], what: string): Promise<Reply> {
    const reply = await this.read();
    if (!ok.includes(reply.code)) throw new SmtpError(`The mail server answered ${what} with ${reply.code} ${reply.lines.at(-1)?.slice(4) ?? ""}`.trim());
    return reply;
  }
}

function connect(server: MailServer): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket =
      server.security === "tls"
        ? tls.connect({ host: server.host, port: server.port, servername: net.isIP(server.host) ? undefined : server.host, ...server.tlsOptions }, () => resolve(socket))
        : net.connect({ host: server.host, port: server.port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Encodes a header value that has non-ASCII characters as RFC 2047 words of at most 10 characters each. */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const chars = [...value];
  const words: string[] = [];
  for (let i = 0; i < chars.length; i += 10) words.push(`=?UTF-8?B?${Buffer.from(chars.slice(i, i + 10).join(""), "utf8").toString("base64")}?=`);
  return words.join("\r\n ");
}

function base64Lines(text: string): string {
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
}

function clean(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new SmtpError(`${what} must be one line`);
  return value;
}

/** The whole message as it goes after DATA, with CRLF line ends. */
export function buildMessage(mail: Mail, now: Date, id: string = randomUUID()): string {
  const domain = mail.from.split("@")[1] ?? "localhost";
  const headers = [
    `From: ${clean(mail.from, "The sender")}`,
    `To: ${mail.to.map((t) => clean(t, "A recipient")).join(", ")}`,
    `Subject: ${encodeHeader(clean(mail.subject, "The subject"))}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}@${domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
  ];
  let body: string;
  if (mail.html) {
    const boundary = `juhandu-${randomBytes(12).toString("hex")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(mail.text),
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(mail.html),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    body = base64Lines(mail.text) + "\r\n";
  }
  const message = headers.join("\r\n") + "\r\n\r\n" + body;
  // Dot-stuffing: no line of ours starts with a dot, but the rule is cheap to keep.
  return message.replace(/(^|\r\n)\./g, "$1..");
}

/** Sends one message. Resolves when the server has accepted it; rejects with a plain-language SmtpError otherwise. */
export async function sendMail(server: MailServer, mail: Mail, now = new Date()): Promise<void> {
  if (!validAddress(mail.from)) throw new SmtpError("The sender address is not valid");
  if (!mail.to.length) throw new SmtpError("There is no recipient");
  for (const to of mail.to) if (!validAddress(to)) throw new SmtpError(`The recipient address ${to} is not valid`);
  if (server.password && server.security === "none" && !LOCAL.has(server.host)) throw new SmtpError("A password is never sent over an unencrypted connection. Choose TLS or STARTTLS.");
  const message = buildMessage(mail, now);

  const socket = await connect(server);
  let conn = new Conn(socket);
  const timer = setTimeout(() => conn.socket.destroy(new SmtpError("The mail server took too long to answer")), server.timeoutMs ?? 30_000);
  try {
    await conn.expect([220], "the greeting");
    const helo = server.helo ?? "juhandu.localhost";
    let caps = (await conn.command(`EHLO ${helo}`, [250])).lines.map((l) => l.slice(4).toUpperCase());
    if (server.security === "starttls") {
      if (!caps.includes("STARTTLS")) throw new SmtpError("The mail server does not offer STARTTLS");
      await conn.command("STARTTLS", [220]);
      conn.socket.removeAllListeners("data");
      conn.socket.removeAllListeners("error");
      conn.socket.removeAllListeners("close");
      const upgraded = tls.connect({ socket: conn.socket, servername: net.isIP(server.host) ? undefined : server.host, ...server.tlsOptions });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve());
        upgraded.once("error", reject);
      });
      conn = new Conn(upgraded);
      caps = (await conn.command(`EHLO ${helo}`, [250])).lines.map((l) => l.slice(4).toUpperCase());
    }
    if (server.user && server.password) {
      const auth = caps.find((c) => c.startsWith("AUTH ")) ?? "";
      if (auth.split(" ").includes("PLAIN")) {
        await conn.command(`AUTH PLAIN ${Buffer.from(`\0${server.user}\0${server.password}`, "utf8").toString("base64")}`, [235]);
      } else if (auth.split(" ").includes("LOGIN")) {
        await conn.command("AUTH LOGIN", [334]);
        await conn.command(Buffer.from(server.user, "utf8").toString("base64"), [334]);
        await conn.command(Buffer.from(server.password, "utf8").toString("base64"), [235]);
      } else {
        throw new SmtpError("The mail server offers no login method this client knows (PLAIN or LOGIN)");
      }
    }
    await conn.command(`MAIL FROM:<${mail.from}>`, [250]);
    for (const to of mail.to) await conn.command(`RCPT TO:<${to}>`, [250, 251]);
    await conn.command("DATA", [354]);
    conn.write(message + (message.endsWith("\r\n") ? "" : "\r\n") + ".\r\n");
    await conn.expect([250], "the message");
    conn.write("QUIT\r\n");
    // The message is already accepted; a server that hangs up without a goodbye is not a failure.
    await conn.read().catch(() => undefined);
  } finally {
    clearTimeout(timer);
    conn.socket.destroy();
  }
}
