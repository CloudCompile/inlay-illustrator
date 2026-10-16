import { describe, expect, test } from "bun:test";
import { layoutStrip, type PanelImage } from "./layout.js";
import type { Storyboard } from "./storyboard-schema.js";
import fixture from "./__fixtures__/storyboard-a2.json" with { type: "json" };

// Bench round 2, source a (validated storyboard); image sizes = the planned sizes, coordinates only (no faces, no cut-outs).
const storyboard = fixture as unknown as Storyboard;
const images: Record<string, PanelImage> = Object.fromEntries(
  storyboard.panels.flatMap((p) => (p.kind === "image" ? [[String(p.id), { width: Number(p.size.split("x")[0]), height: Number(p.size.split("x")[1]) }]] : [])),
);
const inter = (a: number[], b: number[]) => Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!)) * Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!));

describe("webtoon layout (round 2, coordinates only)", () => {
  const layout = layoutStrip(storyboard, images);

  test("panels in reading order, no frame break without a cut-out, balloons never overlap", () => {
    expect(layout.width).toBe(690);
    expect(layout.panels.length).toBe(storyboard.panels.filter((p) => p.kind === "image").length);
    for (let i = 1; i < layout.panels.length; i += 1) expect(layout.panels[i]!.rect[1]).toBeGreaterThanOrEqual(layout.panels[i - 1]!.rect[3]);
    expect(layout.panels.every((p) => p.frameBreak === null && p.cutout === null)).toBe(true);
    const balloons = layout.items.flatMap((i) => (i.kind === "speech" || i.kind === "thought" ? [i] : []));
    for (const [a, b] of balloons.flatMap((a, i) => balloons.slice(i + 1).map((b) => [a, b] as const))) expect(inter(a.rect, b.rect)).toBe(0);
    expect(layout.height).toBeGreaterThan(layout.panels.at(-1)!.rect[3]);
  });

  test("every text item points back at its storyboard text (edit target)", () => {
    for (const item of layout.items) {
      if (item.kind === "title") continue;
      const panel = storyboard.panels.find((p) => p.id === item.panel)!;
      expect(panel.text[item.textIndex]!.text).toBe(item.text);
    }
    const texts = storyboard.panels.flatMap((p) => (p.kind === "image" && p.layout === "title" ? p.text.filter((t) => t.type !== "speech") : p.text));
    expect(layout.items.filter((i) => i.kind !== "title").length).toBe(texts.length);
  });

  test("is deterministic", () => {
    expect(layoutStrip(structuredClone(storyboard), images)).toEqual(layout);
  });
});
