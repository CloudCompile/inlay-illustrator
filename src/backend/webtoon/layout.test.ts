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

  test("narrow strip (phone): same text items, balloons stay inside the strip and off faces", () => {
    const narrow = layoutStrip(storyboard, images, { width: 520 });
    expect(narrow.width).toBe(520);
    expect(narrow.panels.every((p) => p.rect[0] >= 0 && p.rect[2] <= 520)).toBe(true);
    const balloons = (l: typeof layout) => l.items.flatMap((i) => (i.kind === "speech" || i.kind === "thought" ? [i] : []));
    expect(balloons(narrow).map((b) => b.text)).toEqual(balloons(layout).map((b) => b.text));
    const faces = narrow.panels.flatMap((p) => Object.values(p.faces).filter((f): f is NonNullable<typeof f> => !!f));
    for (const b of balloons(narrow)) {
      expect(b.rect[0]).toBeGreaterThanOrEqual(0);
      expect(b.rect[2]).toBeLessThanOrEqual(520);
      const inner = [b.cx - b.rx * 0.92, b.cy - b.ry * 0.92, b.cx + b.rx * 0.92, b.cy + b.ry * 0.92];
      for (const f of faces) expect(inter(inner, f)).toBe(0);
    }
  });

  test("frame-break cut-out: the head crosses the top frame line, balloons keep off the character area", () => {
    // panel 3 (action, one character): the cut-out covers x 0.3..1 from 10% down
    const mask = Array.from({ length: 60 }, (_, r) => (r < 6 ? "0".repeat(40) : "0".repeat(12) + "1".repeat(28)));
    const withCut = { ...images, "3": { ...images["3"]!, cutout: { src: "cut.png", bbox: { left: 0.3, top: 0.1, right: 1, bottom: 1 }, mask } } };
    const cut = layoutStrip(storyboard, withCut);
    const panel = cut.panels.find((p) => p.id === 3)!;
    expect([panel.frameBreak, panel.cutout?.src]).toEqual(["top", "cut.png"]);
    expect(panel.frame[1]).toBeGreaterThan(panel.rect[1]);
    const [x0, y0, x1, y1] = panel.rect;
    const body = [x0 + 0.3 * (x1 - x0), y0 + 0.1 * (y1 - y0), x1, y1];
    const onBody = (l: typeof layout) => l.items.flatMap((i) => (i.panel === 3 && (i.kind === "speech" || i.kind === "thought") ? [inter(i.rect, body) / ((i.rect[2] - i.rect[0]) * (i.rect[3] - i.rect[1]))] : []));
    expect(Math.max(...onBody(cut))).toBeLessThan(0.1);
  });
  test("is deterministic", () => {
    expect(layoutStrip(structuredClone(storyboard), images)).toEqual(layout);
  });
});
