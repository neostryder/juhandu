// Draws the seal (a ring around a diamond) as the app icons: web/icons/icon.svg and the PNG sizes the manifest and iOS need.
// Run with: node scripts/make-icons.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "icons");
mkdirSync(out, { recursive: true });

const GROUND = [0x12, 0x0e, 0x0b] as const;
const GOLD = [0xd9, 0xa4, 0x41] as const;

writeFileSync(
  join(out, "icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#120e0b"/><g fill="none" stroke="#d9a441"><circle cx="256" cy="256" r="174" stroke-width="11"/><circle cx="256" cy="256" r="138" stroke-width="4"/><path d="M256 154l76 102-76 102-76-102z" stroke-width="9" fill="#d9a441" fill-opacity=".25"/><path d="M256 204v104M204 256h104" stroke-width="4"/></g></svg>\n`,
);

/** Coverage (0 to 1) of the seal at a point in unit coordinates centered on the icon. */
function seal(x: number, y: number): number {
  const r = Math.hypot(x, y);
  const ring = Math.abs(r - 0.34) < 0.011 || Math.abs(r - 0.27) < 0.004;
  const d = Math.abs(x) / 0.15 + Math.abs(y) / 0.2;
  const edge = Math.abs(d - 1) < 0.045;
  const fill = d < 1;
  const cross = (Math.abs(x) < 0.004 && Math.abs(y) < 0.1) || (Math.abs(y) < 0.004 && Math.abs(x) < 0.1);
  if (ring || edge || cross) return 1;
  return fill ? 0.25 : 0;
}

function png(size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 3;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let cover = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) cover += seal((px + (sx + 0.5) / SS) / size - 0.5, (py + (sy + 0.5) / SS) / size - 0.5);
      cover /= SS * SS;
      const at = py * (size * 4 + 1) + 1 + px * 4;
      for (let c = 0; c < 3; c++) raw[at + c] = Math.round(GROUND[c]! * (1 - cover) + GOLD[c]! * cover);
      raw[at + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]] as const) writeFileSync(join(out, name), png(size));
console.log("icons written to", out);
