import { test } from "node:test";
import assert from "node:assert/strict";
import { FeedParseError, parseFeed } from "../src/sources/feed-parser.ts";
import { parseXml } from "../src/sources/xml.ts";
import { discoverFeeds } from "../src/sources/discover.ts";
import { parseYoutubeUrl, extractChannelId, youtubeFeedUrl } from "../src/sources/youtube.ts";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Example &amp; Co</title><link>https://example.com/</link>
<item><title><![CDATA[First <b>post</b>]]></title><link>https://example.com/1</link><guid isPermaLink="false">id-1</guid>
<pubDate>Tue, 06 Oct 2026 12:00:00 GMT</pubDate><dc:creator>Ada</dc:creator>
<description>Short &lt;p&gt;summary&lt;/p&gt;</description><content:encoded><![CDATA[<p>Full body</p>]]></content:encoded>
<media:thumbnail url="https://example.com/t.jpg"/></item>
<item><title>No guid</title><link>https://example.com/2</link></item>
</channel></rss>`;

const ATOM_YOUTUBE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
<title>Retro Sound Lab</title><link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
<entry><id>yt:video:VID123</id><yt:videoId>VID123</yt:videoId><yt:channelId>UCabcdefghijklmnopqrstuv</yt:channelId>
<title>SNES music tricks</title><link rel="alternate" href="https://www.youtube.com/watch?v=VID123"/>
<author><name>Retro Sound Lab</name></author><published>2026-10-05T10:00:00+00:00</published>
<media:group><media:title>SNES music tricks</media:title><media:thumbnail url="https://i.ytimg.com/vi/VID123/hqdefault.jpg" width="480" height="360"/><media:description>How it fit in 64 KB</media:description></media:group></entry></feed>`;

test("parses RSS 2.0 with CDATA, entities, dc:creator, content:encoded and media thumbnails", () => {
  const feed = parseFeed(RSS);
  assert.equal(feed.format, "rss");
  assert.equal(feed.title, "Example & Co");
  assert.equal(feed.items.length, 2);
  const first = feed.items[0]!;
  assert.equal(first.guid, "id-1");
  assert.equal(first.title, "First <b>post</b>");
  assert.equal(first.author, "Ada");
  assert.equal(first.publishedAt, "2026-10-06T12:00:00.000Z");
  assert.equal(first.summary, "Short <p>summary</p>");
  assert.equal(first.content, "<p>Full body</p>");
  assert.equal(first.image, "https://example.com/t.jpg");
  assert.equal(feed.items[1]!.guid, "https://example.com/2");
});

test("parses a YouTube Atom feed with video id and media group", () => {
  const feed = parseFeed(ATOM_YOUTUBE);
  assert.equal(feed.format, "atom");
  assert.equal(feed.title, "Retro Sound Lab");
  const item = feed.items[0]!;
  assert.equal(item.extra["youtubeVideoId"], "VID123");
  assert.equal(item.url, "https://www.youtube.com/watch?v=VID123");
  assert.equal(item.summary, "How it fit in 64 KB");
  assert.equal(item.image, "https://i.ytimg.com/vi/VID123/hqdefault.jpg");
});

test("parses RSS 1.0 (RDF) and JSON Feed", () => {
  const rdf = parseFeed(`<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Old</title><link>https://old.example/</link></channel><item><title>Legacy</title><link>https://old.example/a</link><dc:date>2026-01-02T03:04:05Z</dc:date></item></rdf:RDF>`);
  assert.equal(rdf.format, "rdf");
  assert.equal(rdf.items[0]!.publishedAt, "2026-01-02T03:04:05.000Z");
  const json = parseFeed(JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "J", home_page_url: "https://j.example", items: [{ id: "1", url: "https://j.example/1", title: "One", content_text: "text", date_published: "2026-02-03T00:00:00Z", authors: [{ name: "Bo" }] }] }));
  assert.equal(json.format, "jsonfeed");
  assert.equal(json.items[0]!.author, "Bo");
});

test("survives malformed markup and rejects non-feeds", () => {
  const feed = parseFeed(`<rss><channel><title>Broken</title><item><title>Unclosed<link>https://x.example/a</item></channel>`);
  assert.equal(feed.items.length, 1);
  assert.throws(() => parseFeed("<html><body>Not a feed</body></html>"), FeedParseError);
  assert.throws(() => parseFeed('{"hello":"world"}'), FeedParseError);
});

test("autodiscovery reads head links and resolves relative URLs", () => {
  const html = `<html><head><link rel="alternate" type="application/rss+xml" title="Posts" href="/feed.xml"><link rel="stylesheet" href="/a.css"><link href='https://other.example/atom' type='application/atom+xml' rel='alternate'></head></html>`;
  const found = discoverFeeds(html, "https://site.example/blog/");
  assert.deepEqual(
    found.map((f) => f.url),
    ["https://site.example/feed.xml", "https://other.example/atom"],
  );
});

test("recognizes YouTube channel, handle and playlist URLs", () => {
  assert.deepEqual(parseYoutubeUrl("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"), { kind: "channel", id: "UCabcdefghijklmnopqrstuv" });
  assert.deepEqual(parseYoutubeUrl("https://www.youtube.com/@RetroSoundLab/videos"), { kind: "page", url: "https://www.youtube.com/@RetroSoundLab" });
  assert.deepEqual(parseYoutubeUrl("https://www.youtube.com/playlist?list=PL123"), { kind: "playlist", id: "PL123" });
  assert.equal(parseYoutubeUrl("https://example.com/channel/UCabcdefghijklmnopqrstuv"), null);
  assert.equal(youtubeFeedUrl({ kind: "channel", id: "UCx" }), "https://www.youtube.com/feeds/videos.xml?channel_id=UCx");
  assert.equal(extractChannelId('<meta itemprop="identifier" content="UCabcdefghijklmnopqrstuv">'), "UCabcdefghijklmnopqrstuv");
});

test("a closing tag that matches nothing open is ignored, and a stream of them stays fast", () => {
  const tree = parseXml("<a><b>x</c></b><d/></a>");
  const a = tree.children[0]!;
  assert.deepEqual(a.children.map((n) => n.name), ["b", "d"], "the stray </c> neither closes b nor drops d out of a");
  const started = Date.now();
  const deep = "<x>".repeat(2000) + "</nope>".repeat(60000);
  parseXml(deep);
  assert.ok(Date.now() - started < 2000, "unmatched closers must not rescan the open stack each time");
});
