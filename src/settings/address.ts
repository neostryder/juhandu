// Where a model server's address points: this machine, the owner's own network, or the internet. An address saved from the Connect
// screen that points at this machine or a private network needs an explicit confirmation, so the settings screen cannot be used to
// make the server send requests to internal addresses without the owner saying that is what they mean.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type AddressPlace = "this-machine" | "own-network" | "internet";

/** Turns a host name into every address it resolves to. */
export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

export class UnknownHostError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`The host name ${host} could not be found`);
    this.name = "UnknownHostError";
    this.host = host;
  }
}

function placeOfV4(ip: string): AddressPlace {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  if (a === 127 || a === 0) return "this-machine";
  // Private ranges, link-local (which holds cloud metadata services), carrier-grade NAT and VPN ranges, benchmarking, multicast and reserved.
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224) return "own-network";
  return "internet";
}

/** Classifies one IP address, v4 or v6. */
export function placeOfIp(raw: string): AddressPlace {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(ip) === 4) return placeOfV4(ip);
  if (ip === "::1" || ip === "::") return "this-machine";
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return placeOfV4(mapped[1]);
  if (/^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip)) return "own-network";
  return "internet";
}

/** The closest place an address reaches. A name that resolves to several addresses counts as the closest of them. */
export async function placeOf(address: string, resolve: Resolver = systemResolver): Promise<AddressPlace> {
  const host = new URL(address).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "this-machine";
  if (isIP(host)) return placeOfIp(host);
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UnknownHostError(host);
  }
  if (!addresses.length) throw new UnknownHostError(host);
  const places = addresses.map(placeOfIp);
  if (places.includes("this-machine")) return "this-machine";
  if (places.includes("own-network")) return "own-network";
  return "internet";
}
