/**
 * Character frame-break images for webtoon mode (NovelAI V5 transparency + inpainting; nai-alpha bench, route 4). Pure pixel code,
 * no host calls. The panel is first drawn with "transparent background, has alpha" (the cut-out). Then:
 * - detached motion lines and marks are dropped, the cut-out moves down when its head starts too close to the top (the layout only breaks the frame below 3% of the panel height),
 * - the inpainting source is the cut-out over a soft fill of its own colours (a flat fill gives the inpainting model a grey rim),
 * - the mask repaints everything with alpha < 200, widened to whole 8 px blocks,
 * - the inpainted background is flattened to opaque and the cut-out is drawn over it again (the panel image),
 * - above the frame only the head's columns are drawn (a held prop or a door post next to the head would cross the frame alone),
 * - a coarse grid of the cut-out's alpha marks where the character is (balloons keep off it).
 * PNG decode/encode use the platform's deflate streams (8-bit RGB/RGBA, not interlaced: what NovelAI returns).
 */
import type { CutoutBox } from "../../shared/contract/index.js";

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  data: Uint8Array;
}

export const FRAME_BREAK = {
  /** Cut-out pixel (bbox, grid, compositing threshold). */
  solidAlpha: 128,
  /** Inpaint mask: repaint where the cut-out's alpha is below this (nai-alpha route 4). */
  maskAlpha: 200,
  /** The mask covers whole blocks of this size (px). */
  maskBlock: 8,
  /** Head crop over the frame: top share of the character, a column counts at this solid share, gaps and margin (share of the width). */
  headBand: 0.25,
  headColumn: 0.15,
  headGap: 0.01,
  headMargin: 0.02,
  /** Detached parts smaller than this share of the largest part are dropped (motion lines, emotion marks). */
  minPart: 0.15,
  /** A cut-out needs at least this share of fully transparent pixels, else the transparency did not happen. */
  minTransparent: 0.1,
  /** Head start after the shift (share of the image height) and the largest shift. */
  headTop: 0.1,
  maxShift: 0.12,
  /** Character grid columns (rows follow the aspect ratio); a cell counts when this share of it is solid. */
  gridCols: 40,
  gridFill: 0.3,
  /** Soft fill: colour average over 8 px blocks, box blur radius 4 blocks, 3 passes (about a 36 px Gaussian). */
  fillBlock: 8,
  fillRadius: 4,
};

/* ---------------------------------------------------------------- PNG */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function zlib(data: Uint8Array, mode: "compress" | "decompress"): Promise<Uint8Array> {
  const transform = mode === "compress" ? new CompressionStream("deflate") : new DecompressionStream("deflate");
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function decodePng(bytes: Uint8Array): Promise<RgbaImage> {
  if (SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("Not a PNG image.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, colorType = -1;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colorType = body[9]!;
      if (body[8] !== 8 || (colorType !== 6 && colorType !== 2) || body[12] !== 0) throw new Error(`Unsupported PNG (bit depth ${body[8]}, colour type ${colorType}, interlace ${body[12]}).`);
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height || !idat.length) throw new Error("The PNG has no image data.");
  const joined = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  idat.reduce((at, c) => (joined.set(c, at), at + c.length), 0);
  const raw = await zlib(joined, "decompress");
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("The PNG image data is truncated.");
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? rows[out + x - channels]! : 0;
      const b = y ? rows[out - stride + x]! : 0;
      const c = y && x >= channels ? rows[out - stride + x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rows[out + x] = v & 0xff;
    }
  }
  if (channels === 4) return { width, height, data: rows };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    data[j] = rows[i]!;
    data[j + 1] = rows[i + 1]!;
    data[j + 2] = rows[i + 2]!;
    data[j + 3] = 255;
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** RGBA PNG, every row with the "up" filter. */
export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1);
    raw[at] = 2;
    for (let x = 0; x < stride; x += 1) raw[at + 1 + x] = (data[y * stride + x]! - (y ? data[(y - 1) * stride + x]! : 0)) & 0xff;
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", header), chunk("IDAT", await zlib(raw, "compress")), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
}

/* ---------------------------------------------------------------- cut-out */

export interface AlphaInfo {
  /** Share of pixels with alpha 0. */
  transparent: number;
  /** Share of solid pixels (alpha > 128). */
  coverage: number;
  /** Solid pixels' box, normalized; null when there are none. */
  bbox: CutoutBox | null;
}

export function alphaInfo(image: RgbaImage): AlphaInfo {
  const { width, height, data } = image;
  let clear = 0, solid = 0, x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = data[(y * width + x) * 4 + 3]!;
      if (a === 0) clear += 1;
      if (a <= FRAME_BREAK.solidAlpha) continue;
      solid += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  const n = width * height;
  return { transparent: clear / n, coverage: solid / n, bbox: x1 < 0 ? null : { left: x0 / width, top: y0 / height, right: (x1 + 1) / width, bottom: (y1 + 1) / height } };
}

/**
 * Keeps the character: solid parts (alpha > 32, 8-connected) smaller than `FRAME_BREAK.minPart` of the largest part become
 * transparent. NovelAI adds free-floating motion lines and emotion marks on a transparent background; they would set the
 * cut-out's top and cross the frame on their own.
 */
export function keepMainParts(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  const n = width * height;
  const label = new Int32Array(n);
  const sizes: number[] = [0];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start += 1) {
    if (label[start] || data[start * 4 + 3]! <= 32) continue;
    const id = sizes.length;
    let top = 0, size = 0;
    stack[top++] = start;
    label[start] = id;
    while (top) {
      const i = stack[--top]!;
      size += 1;
      const x = i % width, y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx, j = yy * width + xx;
          if (xx < 0 || xx >= width || label[j] || data[j * 4 + 3]! <= 32) continue;
          label[j] = id;
          stack[top++] = j;
        }
      }
    }
    sizes.push(size);
  }
  const largest = Math.max(0, ...sizes);
  if (sizes.every((s) => s === largest || s >= FRAME_BREAK.minPart * largest)) return image;
  const out = new Uint8Array(data);
  for (let i = 0; i < n; i += 1) if (label[i] && sizes[label[i]!]! < FRAME_BREAK.minPart * largest) out[i * 4 + 3] = 0;
  return { width, height, data: out };
}

/**
 * The cut-out as drawn over the frame: in the top quarter of the character (`headBand`), only the widest run of solid columns
 * (the head) is kept, so a held prop or a door post next to the head does not cross the frame on its own. Inside the frame the
 * panel image under it has the same pixels, so only the part above the frame line changes.
 */
export function cropToHead(image: RgbaImage, bbox: CutoutBox): RgbaImage {
  const { width, height, data } = image;
  const y0 = Math.floor(bbox.top * height);
  const y1 = Math.min(height, y0 + Math.max(1, Math.round((bbox.bottom - bbox.top) * height * FRAME_BREAK.headBand)));
  const counts = new Array<number>(width).fill(0);
  for (let y = y0; y < y1; y += 1) for (let x = 0; x < width; x += 1) if (data[(y * width + x) * 4 + 3]! > FRAME_BREAK.solidAlpha) counts[x]! += 1;
  const min = FRAME_BREAK.headColumn * (y1 - y0), gap = Math.round(FRAME_BREAK.headGap * width);
  let best: [number, number] | null = null, start = -1, last = -1;
  for (let x = 0; x <= width; x += 1) {
    const on = x < width && counts[x]! >= min;
    if (on && start < 0) start = x;
    if (on) last = x;
    if (start >= 0 && (x === width || (!on && x - last > gap))) {
      if (!best || last - start > best[1] - best[0]) best = [start, last];
      start = -1;
    }
  }
  if (!best) return image;
  const margin = Math.round(FRAME_BREAK.headMargin * width);
  const [a, b] = [best[0] - margin, best[1] + margin];
  const out = new Uint8Array(data);
  for (let y = 0; y < y1; y += 1) for (let x = 0; x < width; x += 1) if (x < a || x > b) out[(y * width + x) * 4 + 3] = 0;
  return { width, height, data: out };
}

/** Rows moved down by `dy` px (the top becomes transparent, the bottom rows fall off). */
export function shiftDown(image: RgbaImage, dy: number): RgbaImage {
  const stride = image.width * 4;
  const data = new Uint8Array(image.data.length);
  data.set(image.data.subarray(0, Math.max(0, image.height - dy) * stride), dy * stride);
  return { ...image, data };
}

/** Pixels to move the cut-out down so its top starts at `FRAME_BREAK.headTop` (at most `maxShift`). */
export function headShift(info: AlphaInfo, height: number): number {
  if (!info.bbox) return 0;
  return Math.round(Math.min(FRAME_BREAK.maxShift, Math.max(0, FRAME_BREAK.headTop - info.bbox.top)) * height);
}

/**
 * 1 = repaint: alpha below `maskAlpha`, widened to whole 8 px blocks (NovelAI's latent grid). A mask edge inside a block
 * left the source's fill colour as a grey rim around the character (nai-alpha route 4); growing the mask by pixels
 * instead (5 px) kept that rim (webtoon-framebreak.md, rim test).
 */
export function backgroundMask(image: RgbaImage, block: number = FRAME_BREAK.maskBlock): Uint8Array {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const ys = Math.min(height, by + block), xs = Math.min(width, bx + block);
      let any = false;
      for (let y = by; y < ys && !any; y += 1) for (let x = bx; x < xs; x += 1) if (data[(y * width + x) * 4 + 3]! < FRAME_BREAK.maskAlpha) { any = true; break; }
      if (any) for (let y = by; y < ys; y += 1) mask.fill(1, y * width + bx, y * width + xs);
    }
  }
  return mask;
}

/** Black / white RGBA mask image (white = repaint) for NovelAI's infill. */
export function maskImage(mask: Uint8Array, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < mask.length; i += 1) {
    const v = mask[i] ? 255 : 0;
    data.set([v, v, v, 255], i * 4);
  }
  return { width, height, data };
}

/** The cut-out over a blurred average of its own colours, opaque (the infill source). */
export function softFill(image: RgbaImage): RgbaImage {
  const { width, height, data } = image;
  const b = FRAME_BREAK.fillBlock;
  const bw = Math.ceil(width / b), bh = Math.ceil(height / b);
  let sums = [new Float64Array(bw * bh), new Float64Array(bw * bh), new Float64Array(bw * bh), new Float64Array(bw * bh)];
  const total = [0, 0, 0, 0];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4, cell = Math.floor(y / b) * bw + Math.floor(x / b), a = data[i + 3]! / 255;
      for (let c = 0; c < 3; c += 1) {
        sums[c]![cell] += data[i + c]! * a;
        total[c]! += data[i + c]! * a;
      }
      sums[3]![cell] += a;
      total[3]! += a;
    }
  }
  const r = FRAME_BREAK.fillRadius;
  const blur = (src: Float64Array, horizontal: boolean) => {
    const out = new Float64Array(src.length);
    const [lines, len] = horizontal ? [bh, bw] : [bw, bh];
    for (let l = 0; l < lines; l += 1) {
      const at = (i: number) => (horizontal ? l * bw + i : i * bw + l);
      for (let i = 0; i < len; i += 1) {
        let s = 0;
        for (let k = Math.max(0, i - r); k <= Math.min(len - 1, i + r); k += 1) s += src[at(k)]!;
        out[at(i)] = s;
      }
    }
    return out;
  };
  for (let pass = 0; pass < 3; pass += 1) sums = sums.map((s) => blur(blur(s, true), false));
  const mean = total[3]! > 0 ? [0, 1, 2].map((c) => total[c]! / total[3]!) : [128, 128, 128];
  const peak = Math.max(...sums[3]!);
  const colour = (cell: number, c: number) => (sums[3]![cell]! > peak * 1e-3 ? sums[c]![cell]! / sums[3]![cell]! : mean[c]!);
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y += 1) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / b - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / b - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const i = (y * width + x) * 4, a = data[i + 3]! / 255;
      for (let c = 0; c < 3; c += 1) {
        const top = colour(y0 * bw + x0, c) * (1 - tx) + colour(y0 * bw + x1, c) * tx;
        const bottom = colour(y1 * bw + x0, c) * (1 - tx) + colour(y1 * bw + x1, c) * tx;
        out[i + c] = Math.round(data[i + c]! * a + (top * (1 - ty) + bottom * ty) * (1 - a));
      }
      out[i + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** `top` drawn over `base` (same size), result opaque. */
export function flattenOver(base: RgbaImage, top: RgbaImage): RgbaImage {
  if (base.width !== top.width || base.height !== top.height) throw new Error(`Image sizes differ (${base.width}x${base.height} / ${top.width}x${top.height}).`);
  const out = new Uint8Array(base.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const a = top.data[i + 3]! / 255;
    for (let c = 0; c < 3; c += 1) out[i + c] = Math.round(top.data[i + c]! * a + base.data[i + c]! * (1 - a));
    out[i + 3] = 255;
  }
  return { width: base.width, height: base.height, data: out };
}

/** Coarse character area: rows of "0" / "1" cells over the whole image. */
export function characterGrid(image: RgbaImage): string[] {
  const { width, height, data } = image;
  const cols = FRAME_BREAK.gridCols, rows = Math.max(1, Math.round((cols * height) / width));
  const out: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    let line = "";
    const ya = Math.floor((r * height) / rows), yb = Math.floor(((r + 1) * height) / rows);
    for (let c = 0; c < cols; c += 1) {
      const xa = Math.floor((c * width) / cols), xb = Math.floor(((c + 1) * width) / cols);
      let solid = 0;
      for (let y = ya; y < yb; y += 1) for (let x = xa; x < xb; x += 1) if (data[(y * width + x) * 4 + 3]! > FRAME_BREAK.solidAlpha) solid += 1;
      line += solid >= FRAME_BREAK.gridFill * Math.max(1, (yb - ya) * (xb - xa)) ? "1" : "0";
    }
    out.push(line);
  }
  return out;
}

export interface FrameBreakInputs {
  /** The cut-out after the head shift (infill source, panel composite, character area). */
  cutout: RgbaImage;
  /** The cut-out drawn over the frame (`cropToHead`); `info` describes it. */
  display: RgbaImage;
  /** Infill source (cut-out over the soft fill) and mask, PNG bytes. */
  source: Uint8Array;
  mask: Uint8Array;
  shift: number;
  info: AlphaInfo;
}

/** From the transparent generation to the infill inputs. Throws when the image has no usable transparency. */
export async function frameBreakInputs(generated: RgbaImage): Promise<FrameBreakInputs> {
  const transparent = keepMainParts(generated);
  const first = alphaInfo(transparent);
  if (first.transparent < FRAME_BREAK.minTransparent || !first.bbox) throw new Error(`The cut-out has no transparent background (${Math.round(first.transparent * 100)}% clear).`);
  const shift = headShift(first, transparent.height);
  const cutout = shift ? shiftDown(transparent, shift) : transparent;
  const mask = maskImage(backgroundMask(cutout), cutout.width, cutout.height);
  const display = cropToHead(cutout, alphaInfo(cutout).bbox!);
  return { cutout, display, source: await encodePng(softFill(cutout)), mask: await encodePng(mask), shift, info: alphaInfo(display) };
}
