/**
 * Puppet motion model (pure: no DOM, no WebGL). From a rig and the image size it builds
 * - soft part weights at 1/WEIGHT_SCALE resolution: the part's outline (or the ellipse in its box), dilated a little,
 *   blurred into the background, ramped along forearms (the hand bobs, the elbow stays), then front parts own their
 *   pixels and parts behind get what is left;
 * - per-frame affine transforms of every part (head tilt about the neck, breathing lift, hand / item bob, hair and
 *   appendage sway lagging behind their parent), looping every LOOP_SECONDS.
 * The renderer warps each output pixel back by the weighted sum of the part displacements (./renderer.ts).
 */
import { PUPPET_MAX_PARTS, type PuppetPart, type PuppetRig } from "../../shared/contract/puppet.js";

export const WEIGHT_SCALE = 4;
export const LOOP_SECONDS = 4;
const TAU = Math.PI * 2;

/** Front-to-back order: items and hands in front, wings and tails behind the body. */
const Z: Record<string, number> = { item: 6, forearm: 5, head: 4, hair: 3, appendage: 2, torso: 1 };
const KIND_Z: Record<string, number> = { antenna: 4.5, ear: 4.5, wing: 0.5, tail: 0.5, cape: 0.5, ribbon: 2 };

/** `x' = a·x + b·y + c`, `y' = d·x + e·y + f` (pixels). */
export type Affine = [number, number, number, number, number, number];
export const IDENTITY: Affine = [1, 0, 0, 0, 1, 0];

export interface PreparedPart extends PuppetPart {
  index: number;
  /** Pixel box [x0, y0, x1, y1]. */
  px: [number, number, number, number];
  center: [number, number];
  pivotPx: [number, number];
  /** Farthest box corner from the pivot (px): rotations are sized by the displacement at that distance. */
  reach: number;
}

export function prepareParts(rig: Pick<PuppetRig, "parts">, width: number, height: number): PreparedPart[] {
  return rig.parts.slice(0, PUPPET_MAX_PARTS).map((part, index) => {
    const px: [number, number, number, number] = [part.box[0] * width, part.box[1] * height, part.box[2] * width, part.box[3] * height];
    const center: [number, number] = [(px[0] + px[2]) / 2, (px[1] + px[3]) / 2];
    const pivotPx: [number, number] = [part.pivot[0] * width, part.pivot[1] * height];
    const corners = [[px[0], px[1]], [px[2], px[1]], [px[0], px[3]], [px[2], px[3]]] as const;
    const reach = Math.max(20, ...corners.map(([x, y]) => Math.hypot(x - pivotPx[0], y - pivotPx[1])));
    return { ...part, parent: part.parent >= 0 && part.parent < Math.min(rig.parts.length, PUPPET_MAX_PARTS) ? part.parent : -1, index, px, center, pivotPx, reach };
  });
}

/* ------------------------------------------------------------------------------------------------
 * Weights
 * ---------------------------------------------------------------------------------------------- */

export interface WeightMaps {
  width: number;
  height: number;
  /** Effective weights per part (0..1), row-major `width x height`. */
  parts: Float32Array[];
}

/** Scanline fill of a polygon (low-res pixel coordinates; pixel centers at +0.5). */
function fillPolygon(mask: Float32Array, w: number, h: number, poly: Array<[number, number]>): void {
  const xs: number[] = [];
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
      if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) / (yj - yi)) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k]! - 0.5)), to = Math.min(w - 1, Math.floor(xs[k + 1]! - 0.5));
      for (let x = from; x <= to; x++) mask[y * w + x] = 1;
    }
  }
}

function fillEllipse(mask: Float32Array, w: number, h: number, [x0, y0, x1, y1]: [number, number, number, number]): void {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(0.5, (x1 - x0) / 2), ry = Math.max(0.5, (y1 - y0) / 2);
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) mask[y * w + x] = 1;
    }
  }
}

/** One separable pass over rows (`horizontal`) or columns: running max (`max`) or running mean over `[-r, r]`. */
function pass(src: Float32Array, w: number, h: number, r: number, horizontal: boolean, max: boolean): Float32Array {
  const out = new Float32Array(src.length);
  const lines = horizontal ? h : w, len = horizontal ? w : h;
  const at = (line: number, i: number) => (horizontal ? line * w + i : i * w + line);
  for (let line = 0; line < lines; line++) {
    if (max) {
      for (let i = 0; i < len; i++) {
        let m = 0;
        for (let k = Math.max(0, i - r); k <= Math.min(len - 1, i + r); k++) m = Math.max(m, src[at(line, k)]!);
        out[at(line, i)] = m;
      }
      continue;
    }
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[at(line, Math.min(len - 1, Math.max(0, k)))]!;
    for (let i = 0; i < len; i++) {
      out[at(line, i)] = sum / (2 * r + 1);
      sum += src[at(line, Math.min(len - 1, i + r + 1))]! - src[at(line, Math.max(0, i - r))]!;
    }
  }
  return out;
}

const zOf = (p: PuppetPart) => KIND_Z[p.kind ?? ""] ?? Z[p.label] ?? 0;

export function buildWeights(parts: readonly PreparedPart[], width: number, height: number): WeightMaps {
  const w = Math.max(1, Math.ceil(width / WEIGHT_SCALE)), h = Math.max(1, Math.ceil(height / WEIGHT_SCALE));
  const raw = parts.map((part) => {
    let mask: Float32Array = new Float32Array(w * h);
    const lo = part.px.map((v) => v / WEIGHT_SCALE) as [number, number, number, number];
    if (part.outline.length >= 3) fillPolygon(mask, w, h, part.outline.map(([x, y]) => [(x * width) / WEIGHT_SCALE, (y * height) / WEIGHT_SCALE]));
    else fillEllipse(mask, w, h, lo);
    const size = Math.max(lo[2] - lo[0], lo[3] - lo[1]);
    const grow = Math.min(4, Math.max(1, Math.round(size * 0.06)));
    mask = pass(pass(mask, w, h, grow, true, true), w, h, grow, false, true);
    const blur = Math.max(1, Math.round(Math.max(1.5, size * 0.08)));
    for (let i = 0; i < 3; i++) mask = pass(pass(mask, w, h, blur, true, false), w, h, blur, false, false);
    for (let i = 0; i < mask.length; i++) mask[i] = Math.min(1, mask[i]! * 1.15);
    if (part.label === "forearm") {
      const [px, py] = part.pivotPx, ax = part.center[0] - px, ay = part.center[1] - py, len2 = Math.max(1, ax * ax + ay * ay);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const proj = ((x * WEIGHT_SCALE - px) * ax + (y * WEIGHT_SCALE - py) * ay) / (len2 * 2);
          mask[y * w + x]! *= Math.pow(Math.min(1, Math.max(0, proj / 0.55)), 1.2);
        }
      }
    }
    return mask;
  });
  const remaining = new Float32Array(w * h).fill(1);
  for (const part of [...parts].sort((a, b) => zOf(b) - zOf(a))) {
    const mask = raw[part.index]!;
    for (let i = 0; i < mask.length; i++) {
      const e = mask[i]! * remaining[i]!;
      mask[i] = e;
      remaining[i]! -= e;
    }
  }
  return { width: w, height: h, parts: raw };
}

/** RGBA byte textures for the shader, four parts each (PUPPET_MAX_PARTS / 4 of them). */
export function packWeights(maps: WeightMaps): Uint8Array[] {
  const n = maps.width * maps.height;
  const out = Array.from({ length: PUPPET_MAX_PARTS / 4 }, () => new Uint8Array(n * 4));
  maps.parts.forEach((mask, p) => {
    const tex = out[p >> 2], channel = p & 3;
    for (let i = 0; i < n; i++) tex[i * 4 + channel] = Math.round(mask[i]! * 255);
  });
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Motion
 * ---------------------------------------------------------------------------------------------- */

const mul = (a: Affine, b: Affine): Affine => [
  a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2],
  a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5],
];
const translate = (dx: number, dy: number): Affine => [1, 0, dx, 0, 1, dy];
function rotateAbout(theta: number, [px, py]: [number, number]): Affine {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, -s, px - c * px + s * py, s, c, py - s * px - c * py];
}

export interface PuppetFrame {
  /** World transform per part (torso: identity, it breathes through `lift`). */
  mats: Affine[];
  /** Per part `[pivotY, topY, lift]`: torso parts lift by `lift` at their top, nothing at the pivot (px). */
  ramps: Array<[number, number, number]>;
}

/**
 * Frame function of a prepared rig: `t` in [0, 1) is the loop phase. Amplitudes are in thousandths of the image height
 * (strength 1: about 5 px of head tilt on an 832 px image).
 */
export function createMotion(parts: readonly PreparedPart[], height: number, strength = 1): (t: number) => PuppetFrame {
  const amp = (height / 1000) * strength;
  const breath = (t: number) => 0.5 - 0.5 * Math.cos(TAU * t);
  const torsoOf = (character: number) => parts.find((p) => p.label === "torso" && p.character === character);
  const rampTop = (torso: PreparedPart) => torso.px[1];
  const lift = (torso: PreparedPart, y: number, t: number) => {
    const span = Math.max(1, torso.pivotPx[1] - rampTop(torso));
    return -5 * amp * breath(t) * Math.min(1, Math.max(0, (torso.pivotPx[1] - y) / span));
  };
  const local = (p: PreparedPart, t: number): Affine => {
    const k = p.index * 0.7, r = p.reach, s = Math.sin;
    switch (p.label) {
      case "head": return rotateAbout(((6 * amp) / r) * s(TAU * t), p.pivotPx);
      case "hair": return rotateAbout(((6 * amp) / r) * s(TAU * t - 0.9 - 0.2 * k), p.pivotPx);
      case "forearm": return p.resting ? IDENTITY : translate(0.8 * amp * s(TAU * t + 1.7 + k), 7 * amp * s(TAU * t + 1.7 + k));
      case "item": return rotateAbout(((3 * amp) / r) * s(TAU * t + 0.9 + k), p.pivotPx);
      case "appendage":
        if (p.kind === "wing") return rotateAbout(((12 * amp) / r) * s(2 * TAU * t + k), p.pivotPx);
        if (p.kind === "antenna") return rotateAbout(((10 * amp) / r) * s(TAU * t - 1.2 - 0.4 * k), p.pivotPx);
        if (p.kind === "tail") return rotateAbout(((12 * amp) / r) * s(TAU * t - 1), p.pivotPx);
        if (p.kind === "ear") return rotateAbout(((4 * amp) / r) * s(TAU * t - 0.6 - 0.3 * k), p.pivotPx);
        return rotateAbout(((8 * amp) / r) * s(TAU * t - 0.8), p.pivotPx);
      default: return IDENTITY;
    }
  };
  return (t) => {
    const memo = new Map<number, Affine>();
    const world = (p: PreparedPart, depth = 0): Affine => {
      const known = memo.get(p.index);
      if (known) return known;
      const parent = p.parent >= 0 && depth < PUPPET_MAX_PARTS ? parts[p.parent] : undefined;
      let base = IDENTITY;
      if (!parent || parent.label === "torso") {
        const torso = parent ?? torsoOf(p.character);
        if (torso) base = translate(0, lift(torso, p.pivotPx[1], t));
      } else base = world(parent, depth + 1);
      const m = mul(base, local(p, t));
      memo.set(p.index, m);
      return m;
    };
    return {
      mats: parts.map((p) => (p.label === "torso" ? IDENTITY : world(p))),
      ramps: parts.map((p) => (p.label === "torso" ? [p.pivotPx[1], rampTop(p), -5 * amp * breath(t)] : [0, 0, 0])),
    };
  };
}

/**
 * Displacement of pixel (x, y) for a frame and the per-part weights at that pixel: what the shader computes.
 * The output pixel shows the source at `(x, y) - displacement`.
 */
export function displacementAt(frame: PuppetFrame, weights: readonly number[], x: number, y: number): [number, number] {
  let dx = 0, dy = 0;
  frame.mats.forEach((m, i) => {
    const w = weights[i] ?? 0;
    dx += w * ((m[0] - 1) * x + m[1] * y + m[2]);
    dy += w * (m[3] * x + (m[4] - 1) * y + m[5]);
    const [pivotY, topY, lift] = frame.ramps[i]!;
    if (lift) dy += w * lift * Math.min(1, Math.max(0, (pivotY - y) / Math.max(1, pivotY - topY)));
  });
  return [dx, dy];
}
