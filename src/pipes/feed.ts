// A pipe's output as an Atom feed, so any reader can subscribe to it, including Juhandu itself.
import type { PipeEntry } from "./engine.ts";

/** XML 1.0 forbids most control characters, so they are dropped before escaping. */
function esc(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stamp(iso: string | null, fallback: string): string {
  const d = new Date(iso ?? fallback);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

export function renderAtom(pipe: { slug: string; name: string }, entries: PipeEntry[], now: Date): string {
  const updated = entries.length ? stamp(entries[0]?.at ?? null, now.toISOString()) : now.toISOString();
  const items = entries.map((e) => {
    const link = /^https?:\/\//i.test(e.url) ? `<link href="${esc(e.url)}"/>` : "";
    const author = e.author ? `<author><name>${esc(e.author)}</name></author>` : "";
    const tags = e.tags.map((t) => `<category term="${esc(t)}"/>`).join("");
    const body = e.summary || e.text;
    return `<entry><id>${esc(/^https?:\/\//i.test(e.url) ? e.url : `urn:juhandu:item:${e.itemId}`)}</id><title>${esc(e.title || "(untitled)")}</title>${link}<updated>${stamp(e.at, updated)}</updated>${author}${tags}<source><title>${esc(e.source)}</title></source>${body ? `<summary type="text">${esc(body)}</summary>` : ""}</entry>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:juhandu:pipe:${esc(pipe.slug)}</id><title>${esc(pipe.name)}</title><updated>${updated}</updated><generator>Juhandu</generator>${items.join("")}</feed>\n`;
}
