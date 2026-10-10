// Recognizing video pages. YouTube is the one site the rungs read today; other sites are an open item.

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be"]);
const ID = /^[\w-]{11}$/;

/** The 11-character video id of a YouTube watch, short, shorts or embed address, or null when the address is not a single video. */
export function youtubeVideoId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!HOSTS.has(url.hostname)) return null;
  if (url.hostname.endsWith("youtu.be")) {
    const id = url.pathname.split("/")[1] ?? "";
    return ID.test(id) ? id : null;
  }
  const watch = url.pathname === "/watch" ? url.searchParams.get("v") : null;
  if (watch && ID.test(watch)) return watch;
  const path = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})(?:\/|$)/);
  return path ? (path[1] as string) : null;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
