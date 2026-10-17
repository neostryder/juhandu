import { isIP } from "node:net";

/** True when a host name or address points at this machine or a private network, so a public page should not be able to steer a fetch there. Name lookups are not resolved here: only literal addresses and reserved names are caught. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  const family = isIP(host);
  if (family === 4) return privateV4(host.split(".").map(Number) as [number, number, number, number]);
  if (family === 6) return privateV6(host);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
  return !host.includes(".");
}

function privateV4([a, b]: [number, number, number, number]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function privateV6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped) return privateV4((mapped[1] as string).split(".").map(Number) as [number, number, number, number]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1] as string, 16);
    const lo = parseInt(mappedHex[2] as string, 16);
    return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  const first = parseInt(host.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
