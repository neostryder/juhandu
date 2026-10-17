import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed } from "../src/sources/feed-parser.ts";
import { toNewItem } from "../src/ingest/ingest.ts";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "X-WR-CALNAME:My shows",
  "BEGIN:VEVENT",
  "UID:ep-1@example",
  "DTSTART:20261020T010000Z",
  "SUMMARY:Severance 3x01 - The\, Return",
  "DESCRIPTION:A long episode summary that is folded over\r\n  two lines.\\nSecond line.",
  "LOCATION:Apple TV+",
  "URL:https://trakt.example/shows/severance/seasons/3/episodes/1",
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Reminder text that must not leak in",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:ep-2@example",
  "DTSTART;VALUE=DATE:20261022",
  "SUMMARY:Andor 2x05",
  "URL:javascript:alert(1)",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:blank",
  "DTSTART:20261023T000000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("an iCalendar body reads as a feed with one item per event", () => {
  const feed = parseFeed(ICS);
  assert.equal(feed.format, "ical");
  assert.equal(feed.title, "My shows");
  assert.equal(feed.items.length, 2, "an event with no title is skipped");
  const [first, second] = feed.items;
  assert.equal(first?.title, "Severance 3x01 - The, Return");
  assert.equal(first?.url, "https://trakt.example/shows/severance/seasons/3/episodes/1");
  assert.equal(first?.extra["eventStart"], "2026-10-20T01:00:00.000Z");
  assert.match(first?.summary ?? "", /^2026-10-20 01:00 UTC - Apple TV\+\nA long episode summary that is folded over two lines\.\nSecond line\.$/);
  assert.equal((first?.summary ?? "").includes("Reminder"), false, "alarm text stays out");
  assert.equal(first?.guid, "ep-1@example|20261020T010000Z");
  assert.equal(second?.url, "", "a link that is not http or https is dropped");
  assert.match(second?.summary ?? "", /^2026-10-22$/);
});

test("a calendar item stores with the event time in its text and never takes the calendar's own address", () => {
  const item = toNewItem(parseFeed(ICS).items[1]!, "https://calendar.example/my/shows.ics?token=SECRET");
  assert.equal(item.url, "");
  assert.equal(JSON.stringify(item).includes("SECRET"), false);
});

test("an unnamed calendar gets a plain title, and other bodies still fail", () => {
  assert.equal(parseFeed("BEGIN:VCALENDAR\nEND:VCALENDAR").title, "Calendar");
  assert.throws(() => parseFeed("just some text"));
});
