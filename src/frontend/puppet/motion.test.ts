import { describe, expect, test } from "bun:test";
import type { PuppetPart } from "../../shared/contract/puppet.js";
import { buildWeights, createMotion, displacementAt, IDENTITY, packWeights, prepareParts, WEIGHT_SCALE, type Affine } from "./motion.js";

const W = 400, H = 600;
const square = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

const RIG: { parts: PuppetPart[] } = {
  parts: [
    { label: "torso", character: 0, box: [0.25, 0.4, 0.75, 1], outline: [], pivot: [0.5, 0.95], parent: -1 },
    { label: "head", character: 0, box: [0.3, 0.05, 0.7, 0.42], outline: square(0.3, 0.05, 0.7, 0.42), pivot: [0.5, 0.42], parent: 0 },
    { label: "forearm", character: 0, box: [0.6, 0.3, 0.8, 0.75], outline: square(0.6, 0.3, 0.8, 0.75), pivot: [0.7, 0.74], parent: -1 },
    { label: "item", character: 0, box: [0.62, 0.2, 0.78, 0.4], outline: [], pivot: [0.7, 0.36], parent: 2 },
    { label: "forearm", character: 0, box: [0.1, 0.6, 0.25, 0.9], outline: [], pivot: [0.15, 0.62], parent: -1, resting: true },
  ],
};

const at = (maps: ReturnType<typeof buildWeights>, part: number, x: number, y: number) => maps.parts[part]![Math.floor(y / WEIGHT_SCALE) * maps.width + Math.floor(x / WEIGHT_SCALE)]!;
const apply = (m: Affine, [x, y]: [number, number]): [number, number] => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];

describe("puppet weights", () => {
  const parts = prepareParts(RIG, W, H);
  const maps = buildWeights(parts, W, H);

  test("each part owns its silhouette and fades out into the background", () => {
    expect(maps.width).toBe(W / WEIGHT_SCALE);
    expect(at(maps, 1, 200, 100)).toBeGreaterThan(0.95); // inside the head
    expect(at(maps, 1, 20, 100)).toBe(0); // far background
    const edge = at(maps, 1, 0.3 * W - 6, 100); // just outside the head outline
    expect(edge).toBeGreaterThan(0.05);
    expect(edge).toBeLessThan(0.9);
  });

  test("front parts take overlapping pixels and weights never sum above 1", () => {
    // The item (in front) overlaps the head's right side.
    expect(at(maps, 3, 0.68 * W, 0.3 * H)).toBeGreaterThan(0.9);
    expect(at(maps, 1, 0.68 * W, 0.3 * H)).toBeLessThan(0.1);
    for (let i = 0; i < maps.width * maps.height; i++) {
      const sum = maps.parts.reduce((total, part) => total + part[i]!, 0);
      expect(sum).toBeLessThanOrEqual(1.0001);
    }
  });

  test("forearms ramp from the elbow (still) to the hand (full)", () => {
    expect(at(maps, 2, 0.7 * W, 0.73 * H)).toBeLessThan(0.05);
    expect(at(maps, 2, 0.7 * W, 0.45 * H)).toBeGreaterThan(0.9);
  });

  test("packs parts into RGBA textures, four parts each", () => {
    const [a, b, c] = packWeights(maps);
    const i = Math.floor((0.25 * H) / WEIGHT_SCALE) * maps.width + Math.floor(200 / WEIGHT_SCALE);
    expect(a[i * 4 + 1]).toBeGreaterThan(240); // part 1 (head) in channel G of texture 0
    // Texture 1 holds parts 4-7: only the resting forearm (channel R) exists.
    expect(b.filter((v, k) => k % 4 !== 0 && v !== 0)).toHaveLength(0);
    expect(Math.max(...b.filter((_, k) => k % 4 === 0))).toBeGreaterThan(200);
    expect(b.length).toBe(maps.width * maps.height * 4);
    expect(c!.every((v) => v === 0)).toBe(true);
  });
});

describe("puppet motion", () => {
  const parts = prepareParts(RIG, W, H);

  test("loops: t = 0 and t = 1 give the same frame", () => {
    const frame = createMotion(parts, H);
    const a = frame(0), b = frame(1);
    a.mats.forEach((m, i) => m.forEach((v, k) => expect(v).toBeCloseTo(b.mats[i]![k]!, 9)));
  });

  test("strength 0 keeps everything still", () => {
    const { mats, ramps } = createMotion(parts, H, 0)(0.3);
    for (const m of mats) m.forEach((v, k) => expect(v).toBeCloseTo(IDENTITY[k]!, 12));
    for (const [, , lift] of ramps) expect(lift).toBeCloseTo(0, 12);
  });

  test("the head tilts about the neck by a few pixels; the resting forearm does not bob", () => {
    const { mats } = createMotion(parts, H)(0.25);
    const head = parts[1]!;
    const [nx, ny] = apply(mats[1]!, head.pivotPx);
    expect(Math.hypot(nx - head.pivotPx[0], ny - head.pivotPx[1])).toBeLessThan(3); // only the breathing lift
    const top: [number, number] = [head.px[0], head.px[1]];
    const [tx, ty] = apply(mats[1]!, top);
    const moved = Math.hypot(tx - top[0], ty - top[1]);
    expect(moved).toBeGreaterThan(2);
    expect(moved).toBeLessThan(10);
    const resting = parts[4]!;
    const [rx] = apply(mats[4]!, resting.pivotPx);
    expect(rx).toBeCloseTo(resting.pivotPx[0], 6);
  });

  test("a held item follows its forearm", () => {
    const frame = createMotion(parts, H)(0.1);
    const item = parts[3]!;
    const viaItem = apply(frame.mats[3]!, item.pivotPx);
    const viaForearm = apply(frame.mats[2]!, item.pivotPx);
    expect(viaItem[0]).toBeCloseTo(viaForearm[0], 6);
    expect(viaItem[1]).toBeCloseTo(viaForearm[1], 6);
    expect(Math.abs(viaItem[1] - item.pivotPx[1])).toBeGreaterThan(1);
  });

  test("the torso breathes: nothing at the waist, full lift at the shoulders", () => {
    const frame = createMotion(parts, H)(0.5);
    const torso = parts[0]!;
    const only = (part: number) => parts.map((_, i) => (i === part ? 1 : 0));
    expect(displacementAt(frame, only(0), W / 2, torso.pivotPx[1])[1]).toBeCloseTo(0, 6);
    const [, lift] = displacementAt(frame, only(0), W / 2, torso.px[1]);
    expect(lift).toBeCloseTo(-5 * (H / 1000), 6);
  });
});
