import type { ParsedFeed, ParsedItem } from "./feed-parser.ts";

const MAX_EVENTS = 2000;
const MAX_FIELD = 4000;

/** Undoes iCalendar line folding: a line that starts with a space or tab continues the one before it. */
function unfold(body: string): string[] {
  return body.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Prop | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const [name = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** A DATE or DATE-TIME value as an ISO string; a time without Z (floating or with a TZID) is read as UTC, which is close enough to sort and read by. */
function toIso(value: string): string | null {
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?Z?$/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clip(text: string): string {
  return text.length > MAX_FIELD ? text.slice(0, MAX_FIELD) : text;
}

function whenText(iso: string, allDay: boolean): string {
  return allDay ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * Reads an iCalendar (.ics) body as a feed: each VEVENT becomes an item titled by its SUMMARY, with the start time, place and description as text.
 * The event's own start time is kept in extra.eventStart; the item is dated when it was fetched, so an upcoming event shows up as new.
 */
export function parseICalendar(body: string): ParsedFeed {
  const lines = unfold(body.replace(/^﻿/, ""));
  let title = "";
  const items: ParsedItem[] = [];
  let event: Prop[] | null = null;
  let alarmDepth = 0;
  for (const line of lines) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const kind = prop.value.trim().toUpperCase();
      if (kind === "VEVENT" && !event) event = [];
      else if (event && kind === "VALARM") alarmDepth++;
      continue;
    }
    if (prop.name === "END") {
      const kind = prop.value.trim().toUpperCase();
      if (kind === "VALARM" && alarmDepth > 0) {
        alarmDepth--;
      } else if (kind === "VEVENT" && event) {
        if (items.length < MAX_EVENTS) {
          const item = eventItem(event);
          if (item) items.push(item);
        }
        event = null;
      }
      continue;
    }
    if (event) {
      if (alarmDepth === 0) event.push(prop);
    } else if (prop.name === "X-WR-CALNAME" && !title) {
      title = clip(unescapeText(prop.value));
    }
  }
  return { format: "ical", title: title || "Calendar", siteUrl: "", items };
}

function eventItem(props: Prop[]): ParsedItem | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const summary = unescapeText(get("SUMMARY")?.value ?? "").trim();
  if (!summary) return null;
  const start = get("DTSTART");
  const iso = start ? toIso(start.value) : null;
  const allDay = start?.params["VALUE"] === "DATE" || (start?.value.trim().length ?? 0) === 8;
  const uid = (get("UID")?.value ?? "").trim();
  const location = unescapeText(get("LOCATION")?.value ?? "").trim();
  const description = unescapeText(get("DESCRIPTION")?.value ?? "").trim();
  const head = [iso ? whenText(iso, allDay) : "", location].filter(Boolean).join(" - ");
  const url = (get("URL")?.value ?? "").trim();
  const extra: Record<string, string> = {};
  if (iso) extra["eventStart"] = iso;
  return {
    guid: clip(`${uid || summary}|${start?.value.trim() ?? ""}`),
    url: /^https?:\/\//i.test(url) ? url : "",
    title: clip(summary),
    author: "",
    publishedAt: null,
    summary: clip([head, description].filter(Boolean).join("\n")),
    content: "",
    image: "",
    extra,
  };
}
