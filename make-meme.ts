// make-meme.ts — draws meme.png for the ghost-got-paid entry.
// Pure Node standard library, fully deterministic: a seeded PRNG drives
// every "random" choice, so two runs always produce identical bytes.

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- PRNG
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- CRC32
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- PNG out
type RGB = readonly [number, number, number];

const W = 1200;
const H = 1200;
const buf = new Uint8Array(W * H * 3);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(out.subarray(4, 8), 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function encodePng(): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, W);
  ihdrView.setUint32(4, H);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2: truecolour RGB, no alpha
  const raw = new Uint8Array(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter: none
    raw.set(buf.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = deflateSync(raw);
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", new Uint8Array(idat)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { png.set(part, at); at += part.length; }
  return png;
}

// ---------------------------------------------------------------- canvas
function setPx(x: number, y: number, c: RGB): void {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
  const i = (yi * W + xi) * 3;
  buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
}

function hex(value: string): RGB {
  const n = parseInt(value.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
  for (let yy = Math.floor(y); yy < y + h; yy++)
    for (let xx = Math.floor(x); xx < x + w; xx++) setPx(xx, yy, c);
}

function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setPx(x, y, c);
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
  for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
    for (let x = Math.floor(cx - rx); x <= cx + rx; x++)
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) setPx(x, y, c);
}

function thickLine(
  x0: number, y0: number, x1: number, y1: number, width: number, c: RGB,
): void {
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    fillCircle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, width / 2, c);
  }
}

function fillPolygon(points: ReadonlyArray<readonly [number, number]>, c: RGB): void {
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of points) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let y = Math.floor(minY); y <= maxY; y++) {
    const nodes: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [xa, ya] = points[i];
      const [xb, yb] = points[(i + 1) % points.length];
      if ((ya <= y && yb > y) || (yb <= y && ya > y)) {
        nodes.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
    }
    nodes.sort((p, q) => p - q);
    for (let i = 0; i + 1 < nodes.length; i += 2)
      for (let x = Math.floor(nodes[i]); x <= nodes[i + 1]; x++) setPx(x, y, c);
  }
}

function strokeArc(
  cx: number, cy: number, rx: number, ry: number,
  from: number, to: number, width: number, c: RGB,
): void {
  const steps = Math.max(8, Math.ceil(Math.abs(to - from) * Math.max(rx, ry)));
  for (let s = 0; s <= steps; s++) {
    const a = from + ((to - from) * s) / steps;
    fillCircle(cx + rx * Math.cos(a), cy + ry * Math.sin(a), width / 2, c);
  }
}

function starPoints(
  cx: number, cy: number, spikes: number, outer: number, inner: number,
  rotation = -Math.PI / 2,
): Array<readonly [number, number]> {
  const pts: Array<readonly [number, number]> = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation + (i * Math.PI) / spikes;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// ---------------------------------------------------------------- font
// A hand-made 5x7 bitmap font. Each glyph is seven rows of five pixels.
const GLYPHS: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "#####"],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", ".#.#.", "..#..", "..#..", "..#..", ".#.#.", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#..##", "#.#.#", "##..#", "#...#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#." ],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", "..#..", "..#..", "..#.."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  "$": ["..#..", ".####", "#.#..", ".###.", "..#.#", "####.", "..#.."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

function glyphWidth(scale: number): number { return 6 * scale; }

function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : text.length * glyphWidth(scale) - scale;
}

function drawText(
  text: string, x: number, y: number, scale: number, c: RGB,
): void {
  let cursor = x;
  for (const rawCh of text.toUpperCase()) {
    const glyph = GLYPHS[rawCh] ?? GLYPHS["?"];
    for (let row = 0; row < 7; row++)
      for (let col = 0; col < 5; col++)
        if (glyph[row][col] === "#")
          fillRect(cursor + col * scale, y + row * scale, scale, scale, c);
    cursor += glyphWidth(scale);
  }
}

function drawTextCentred(
  text: string, cx: number, y: number, scale: number, c: RGB,
): void {
  drawText(text, Math.round(cx - textWidth(text, scale) / 2), y, scale, c);
}

// Bold caption treatment: a dark outline pass offset in every direction,
// then the fill drawn twice with a small offset for extra weight.
function drawCaption(
  text: string, cx: number, y: number, scale: number, fill: RGB,
): void {
  const outline = hex("#14041f");
  const startX = Math.round(cx - textWidth(text, scale) / 2);
  for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-3, -3], [3, 3], [-3, 3], [3, -3]] as const)
    drawText(text, startX + dx, y + dy, scale, outline);
  drawText(text, startX, y, scale, fill);
  drawText(text, startX + 2, y, scale, fill);
}

// ---------------------------------------------------------------- scene
const rand = mulberry32(2013);

function drawSky(): void {
  const stops: Array<[number, RGB]> = [
    [0, hex("#190a33")],
    [0.3, hex("#4a1160")],
    [0.48, hex("#a4136b")],
    [0.62, hex("#ff7b39")],
    [0.66, hex("#ff7b39")],
  ];
  for (let y = 0; y < 800; y++) {
    const t = y / 800;
    let c = stops[stops.length - 1][1];
    for (let i = 0; i + 1 < stops.length; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) {
        c = mix(stops[i][1], stops[i + 1][1],
          (t - stops[i][0]) / (stops[i + 1][0] - stops[i][0]));
        break;
      }
    }
    if (t < stops[0][0]) c = stops[0][1];
    fillRect(0, y, W, 1, c);
  }
  // Stars scattered through the top of the sky.
  for (let i = 0; i < 90; i++) {
    const x = Math.floor(rand() * W);
    const y = Math.floor(rand() * 320);
    const s = rand() < 0.25 ? 4 : 2;
    fillRect(x, y, s, s, hex("#ffffff"));
  }
}

function drawSun(): void {
  const cx = 600, cy = 690, r = 200;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    const t = (y - (cy - r)) / (2 * r);
    const c = mix(hex("#ffd23f"), hex("#ff5e78"), t);
    const half = Math.sqrt(Math.max(0, r * r - (y - cy) ** 2));
    fillRect(cx - half, y, half * 2, 1, c);
  }
  // Dark slice gaps across the lower third, retro-synthwave style.
  const skyGap = hex("#8f1460");
  for (const [gy, gh] of [[790, 10], [822, 14], [856, 18]] as const)
    fillRect(cx - r, gy, r * 2, gh, skyGap);
}

function drawSkyline(): void {
  const dark = hex("#170631");
  const buildings: Array<[number, number, number]> = [
    // [x, width, topY] — silhouettes standing along y 640-790.
    [0, 90, 680], [95, 70, 640], [170, 100, 700], [275, 80, 655],
    [360, 110, 690], [475, 90, 645], [570, 120, 705], [695, 85, 660],
    [785, 105, 695], [895, 75, 650], [975, 110, 700], [1090, 110, 670],
  ];
  for (const [x, w, top] of buildings) fillRect(x, top, w, 790 - top, dark);
  // Tiny lit windows, seeded so they never move between runs.
  const lit = hex("#ffd76a");
  for (let i = 0; i < 40; i++) {
    const [bx, bw, top] = buildings[Math.floor(rand() * buildings.length)];
    const wx = bx + 8 + rand() * Math.max(4, bw - 20);
    const wy = top + 12 + rand() * Math.max(4, 760 - top);
    fillRect(wx, wy, 6, 8, lit);
  }
  // Neon signs: a soft glow pass first, then the bright lettering.
  drawText("LEONIDA", 408, 706, 6, hex("#7c1d4e"));
  drawText("LEONIDA", 410, 708, 6, hex("#ff5da2"));
  drawText("MAKE.FUN", 1004, 716, 3, hex("#0e4a56"));
  drawText("MAKE.FUN", 1006, 718, 3, hex("#37e0e0"));
}

function drawGround(): void {
  const top = hex("#2a0a2e"), bottom = hex("#0d0316");
  for (let y = 790; y < H; y++)
    fillRect(0, y, W, 1, mix(top, bottom, (y - 790) / (H - 790)));
  fillRect(0, 800, W, 60, hex("#3d1238")); // boardwalk band
  fillRect(0, 798, W, 5, hex("#37e0e0")); // cyan neon strip
}

function drawPalm(baseX: number, lean: number): void {
  const c = hex("#12041f");
  // Curved trunk: stacked thick segments leaning as they climb.
  let x = baseX, y = 800;
  for (let s = 0; s < 9; s++) {
    const nx = x + lean * (s / 9) * 6, ny = y - 34;
    thickLine(x, y, nx, ny, 20 - s, c);
    x = nx; y = ny;
  }
  // Eight drooping fronds from the crown.
  for (let f = 0; f < 8; f++) {
    const a = Math.PI + (f / 7) * Math.PI; // fan across the top
    const midX = x + Math.cos(a) * 95, midY = y + Math.sin(a) * 55 - 26;
    const endX = x + Math.cos(a) * 165, endY = midY + 62;
    thickLine(x, y, midX, midY, 11, c);
    thickLine(midX, midY, endX, endY, 7, c);
  }
}

function drawBench(): void {
  const wood = hex("#3a1c28"), dark = hex("#12041f");
  fillRect(250, 905, 510, 16, wood); // back slats
  fillRect(250, 935, 510, 16, wood);
  fillRect(250, 985, 510, 22, wood); // seat
  fillRect(262, 921, 14, 90, dark); // legs and posts
  fillRect(734, 921, 14, 90, dark);
  fillRect(262, 1007, 14, 42, dark);
  fillRect(734, 1007, 14, 42, dark);
}

function drawSkeleton(): void {
  const bone = hex("#f2ead8"), shade = hex("#d8cdb2"), ink = hex("#241a12");
  // Legs first (behind the bench seat line reads fine at meme scale).
  thickLine(330, 960, 300, 1045, 17, shade);
  thickLine(330, 960, 375, 1045, 17, shade);
  thickLine(300, 1045, 296, 1118, 14, bone);
  thickLine(375, 1045, 380, 1118, 14, bone);
  fillRect(278, 1112, 42, 12, bone); // foot bones
  fillRect(362, 1112, 42, 12, bone);
  // Pelvis and segmented spine.
  fillEllipse(330, 960, 40, 20, bone);
  for (let s = 0; s < 5; s++) fillEllipse(330, 862 + s * 19, 15, 9, shade);
  // Rib arcs on both sides of the spine.
  for (let rIdx = 0; rIdx < 4; rIdx++) {
    const ry = 884 + rIdx * 18;
    strokeArc(330, ry, 46 - rIdx * 3, 13, Math.PI * 0.15, Math.PI * 0.95, 6, bone);
    strokeArc(330, ry, 46 - rIdx * 3, 13, Math.PI * 1.05, Math.PI * 1.85, 6, bone);
  }
  // Left arm down to a game controller.
  thickLine(300, 885, 272, 922, 14, bone);
  thickLine(272, 922, 255, 960, 13, bone);
  fillCircle(255, 960, 13, bone);
  fillRect(225, 945, 64, 38, ink); // controller body
  fillCircle(243, 964, 6, hex("#ff2d95"));
  fillCircle(272, 964, 6, hex("#37e0e0"));
  // Right arm out to a pale paper ticket.
  thickLine(360, 885, 392, 920, 14, bone);
  thickLine(392, 920, 415, 955, 13, bone);
  fillCircle(415, 955, 13, bone);
  fillPolygon([[392, 938], [446, 930], [450, 960], [396, 968]], hex("#efe6cc"));
  drawText("2013", 398, 942, 2, ink);
  // Skull: cranium, jaw, sockets, nose and teeth.
  fillEllipse(330, 800, 52, 58, bone);
  fillEllipse(344, 818, 40, 40, shade);
  fillEllipse(330, 800, 52, 58, bone);
  fillRect(302, 846, 56, 30, bone);
  fillEllipse(308, 796, 14, 17, ink);
  fillEllipse(352, 796, 14, 17, ink);
  fillPolygon([[330, 812], [322, 830], [338, 830]], ink);
  for (let tIdx = 0; tIdx < 4; tIdx++)
    thickLine(312 + tIdx * 12, 848, 312 + tIdx * 12, 874, 3, ink);
  // Cobweb between the skull and the bench's left end.
  const web = hex("#cfc8d8");
  const corner: readonly [number, number] = [255, 745];
  const anchors: Array<readonly [number, number]> = [
    [300, 752], [316, 772], [322, 800], [300, 838], [272, 856],
  ];
  for (const [ax, ay] of anchors) thickLine(corner[0], corner[1], ax, ay, 2, web);
  for (const t of [0.35, 0.6, 0.85]) {
    const pts = anchors.map(([ax, ay]) =>
      [corner[0] + (ax - corner[0]) * t, corner[1] + (ay - corner[1]) * t] as const);
    for (let i = 0; i + 1 < pts.length; i++)
      thickLine(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 2, web);
  }
}

function ghostBodyPoints(ox: number, oy: number): Array<readonly [number, number]> {
  const pts: Array<readonly [number, number]> = [];
  const cx = 840 + ox, cy = 670 + oy, r = 150;
  for (let s = 0; s <= 24; s++) {
    const a = Math.PI + (s / 24) * Math.PI; // dome, left to right over the top
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  pts.push([990 + ox, 982 + oy]);
  // Wavy bottom edge: four scallops dipping upward, right to left.
  for (let sc = 0; sc < 4; sc++) {
    const sx = 990 - sc * 75 + ox;
    for (let s = 1; s <= 8; s++) {
      const a = (s / 8) * Math.PI;
      pts.push([sx - (s / 8) * 75, 982 + oy - Math.sin(a) * 28]);
    }
  }
  pts.push([690 + ox, 670 + oy]);
  return pts;
}

function drawGhost(): void {
  const white = hex("#ffffff"), navy = hex("#14102e");
  // Soft shadow copy, then the white body itself.
  fillPolygon(ghostBodyPoints(10, 12), hex("#7c0f52"));
  fillPolygon(ghostBodyPoints(0, 0), white);
  // Raised left arm holding the star coin.
  thickLine(700, 760, 655, 690, 34, white);
  fillCircle(655, 690, 20, white);
  // Sparkle eyes — the mascot's signature four-point stars.
  fillPolygon(starPoints(775, 640, 4, 34, 10), navy);
  fillPolygon(starPoints(885, 640, 4, 34, 10), navy);
  // Smile and blush.
  strokeArc(830, 682, 34, 26, Math.PI * 0.15, Math.PI * 0.85, 7, navy);
  fillCircle(745, 690, 13, hex("#ffb3c8"));
  fillCircle(915, 690, 13, hex("#ffb3c8"));
  // Gold chain with a pendant across the chest.
  strokeArc(830, 742, 95, 52, Math.PI * 0.1, Math.PI * 0.9, 4, hex("#ffd23f"));
  fillCircle(830, 794, 11, hex("#ffd23f"));
  // Magenta star coin in the raised hand.
  fillCircle(640, 615, 58, hex("#ff2d95"));
  strokeArc(640, 615, 58, 58, 0, Math.PI * 2, 6, hex("#ffd23f"));
  fillPolygon(starPoints(640, 615, 5, 30, 13), white);
  for (const [sx, sy] of [[566, 548], [716, 556], [640, 516]] as const)
    fillPolygon(starPoints(sx, sy, 4, 13, 4), hex("#ffd23f"));
  // Money bag in the right hand.
  thickLine(962, 780, 975, 822, 30, white);
  fillCircle(975, 862, 50, hex("#37d67a"));
  fillPolygon([[952, 826], [998, 826], [986, 800], [964, 800]], hex("#37d67a"));
  thickLine(958, 824, 992, 824, 7, hex("#0d3a22"));
  drawText("$", 958, 838, 6, hex("#0d3a22"));
}

function drawScene(): void {
  drawSky();
  drawSun();
  drawSkyline();
  drawGround();
  drawPalm(110, -1);
  drawPalm(1090, 1);
  drawBench();
  drawSkeleton();
  drawGhost();
  drawCaption("WAITING FOR GTA VI", 600, 56, 9, hex("#ffffff"));
  drawCaption("SINCE 2013...", 600, 150, 9, hex("#ffd23f"));
  drawCaption("THE GHOST GOT PAID", 600, 1126, 8, hex("#7dff9a"));
}

drawScene();
const outPath = join(dirname(fileURLToPath(import.meta.url)), "meme.png");
writeFileSync(outPath, encodePng());
console.log(`make-meme: wrote ${outPath}`);

