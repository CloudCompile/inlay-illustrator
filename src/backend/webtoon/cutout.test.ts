import { describe, expect, test } from "bun:test";
import { characterGrid, decodePng, encodePng, frameBreakInputs, type RgbaImage } from "./cutout.js";

/** 64 x 96, transparent except a solid red block x 16..47, y from `top` down. */
function syntheticCutout(top = 2, width = 64, height = 96): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = top; y < height; y += 1) for (let x = 16; x < 48; x += 1) data.set([220, 40, 40, 255], (y * width + x) * 4);
  return { width, height, data };
}

describe("frame-break cut-out", () => {
  test("PNG round trip", async () => {
    const image = syntheticCutout();
    expect(await decodePng(await encodePng(image))).toEqual(image);
  });

  test("cut-out moves down to 10%, the mask covers whole 8 px blocks with background, the source is opaque", async () => {
    const fb = await frameBreakInputs(syntheticCutout());
    expect(fb.shift).toBe(8);
    expect(fb.info.bbox).toEqual({ left: 0.25, top: 10 / 96, right: 0.75, bottom: 1 });
    const mask = await decodePng(fb.mask);
    const at = (img: RgbaImage, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
    expect([at(mask, 20, 12)[0], at(mask, 20, 20)[0], at(mask, 4, 50)[0], at(mask, 47, 60)[0]]).toEqual([255, 0, 255, 0]);
    const source = await decodePng(fb.source);
    expect(at(source, 30, 50)).toEqual([220, 40, 40, 255]);
    expect(at(source, 2, 2)[3]).toBe(255);
    const grid = characterGrid(fb.cutout);
    expect(grid.length).toBe(60);
    expect([grid[3]![20], grid[30]![20], grid[30]![2]]).toEqual(["0", "1", "0"]);
  });

  test("detached small marks are dropped from the cut-out", async () => {
    const image = syntheticCutout(40);
    for (let y = 2; y < 6; y += 1) for (let x = 2; x < 8; x += 1) image.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
    const fb = await frameBreakInputs(image);
    expect(fb.info.bbox!.top).toBe(40 / 96);
  });

  test("an image without a transparent background is refused", async () => {
    const opaque = syntheticCutout();
    for (let i = 3; i < opaque.data.length; i += 4) opaque.data[i] = 255;
    await expect(frameBreakInputs(opaque)).rejects.toThrow(/no transparent background/u);
  });
});
