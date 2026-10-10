import { createHash } from "node:crypto";
import { decodeEntities } from "./sources/xml.ts";

/** Turns feed HTML into plain text. Feed text is untrusted: the result is only ever shown as text, never as markup. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function excerpt(text: string, max = 600): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "...";
}

/** Normalized title fingerprint, used later for duplicate and story matching across sources. */
export function titleHash(title: string): string {
  const normalized = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? createHash("sha1").update(normalized).digest("hex").slice(0, 16) : "";
}
