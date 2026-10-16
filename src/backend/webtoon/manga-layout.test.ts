import { describe, expect, test } from "bun:test";
import { mangaLayoutWidth, MANGA_PAGE_WIDTH, type Rect } from "../../shared/contract/webtoon.js";
import { choosePages, layoutManga, mangaPagePlan, pageCells, readingOrderErrors, TEMPLATES } from "./manga-layout.js";
import type { ImagePanel, Importance, Storyboard } from "./storyboard-schema.js";

const IMPS: Importance[] = ["big", "small", "normal", "normal", "normal", "small", "normal", "normal", "big", "normal", "small", "big", "small"];
const inter = (a: Rect, b: Rect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

function panel(id: number, importance: Importance, extra: Partial<ImagePanel> = {}): ImagePanel {
  return { id, kind: "image", beat: "dialogue", importance, size: "1024x1024", layout: "full_width", nai: { base: "upper body, room", characters: [] }, text: [], ...extra };
}

/** The manga prototype's p8: two faces high in a normal cell, two long balloons, the first speaker on the right. */
const crowded = (id: number, importance: Importance) =>
  panel(id, importance, {
    nai: { base: "upper body", characters: [{ name: "Natsuki", x: 0.7, y: 0.5, framing: "upper body", prompt: "" }, { name: "Jay", x: 0.3, y: 0.3, framing: "upper body", prompt: "" }] },
    text: [
      { type: "speech", speaker: "Natsuki", text: "Because the commander's daughter was being held hostage... dummy!", anchor: "top" },
      { type: "speech", speaker: "Jay", text: "Must've been a crazy strong gust of wind...", anchor: "top" },
    ],
  });

function storyboard(): Storyboard {
  const panels = IMPS.map((imp, i) => (i === 7 ? crowded(i + 1, imp) : panel(i + 1, imp)));
  const plan = mangaPagePlan(panels);
  for (const p of panels) p.size = plan.sizes[p.id] as ImagePanel["size"];
  return { title: "Chapter 2: Half-Packed Bags", panels, pages: plan.pages };
}

const images = (sb: Storyboard) => Object.fromEntries((sb.panels as ImagePanel[]).map((p) => {
  const [width, height] = p.size.split("x").map(Number);
  const faces = p.id === 8 ? { Natsuki: { left: 0.62, top: 0.16, right: 0.78, bottom: 0.34 }, Jay: { left: 0.22, top: 0.16, right: 0.38, bottom: 0.34 } } : undefined;
  return [String(p.id), { width: width!, height: height!, ...(faces ? { faces } : {}) }];
}));

describe("manga pages", () => {
  test("templates and page split follow the panels' importance; sizes come from the cells", () => {
    expect(choosePages(IMPS).map((p) => p.template.id)).toEqual(["4c", "5d", "4d"]);
    for (let n = 4; n <= 14; n++) expect(choosePages(Array<Importance>(n).fill("normal")).reduce((sum, p) => sum + p.template.rows.flatMap((r) => r.cells).length, 0)).toBe(n);
    const plan = mangaPagePlan(IMPS.map((importance, i) => ({ id: i + 1, importance })));
    expect(plan.pages.map((p) => p.panels)).toEqual([[1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13]]);
    expect([plan.sizes[1], plan.sizes[2], plan.sizes[13]]).toEqual(["1024x1024", "704x1472", "1600x640"]);
  });

  test("right-to-left reading order: cells right to left within a row, balloons of a crowded panel in order and off faces", () => {
    const t4c = pageCells(TEMPLATES.find((t) => t.id === "4c")!);
    expect(t4c[0]!.bbox[0]).toBeGreaterThan(t4c[1]!.bbox[0]); // big cell right, small cell left
    expect(t4c[2]!.bbox[0]).toBeGreaterThan(t4c[3]!.bbox[0]);
    const sb = storyboard();
    const layout = layoutManga(sb, images(sb));
    expect([layout.width, layout.pages?.length, layout.format]).toEqual([MANGA_PAGE_WIDTH, 3, "manga"]);
    expect(readingOrderErrors(layout)).toEqual([]);
    const p8 = layout.panels.find((p) => p.id === 8)!;
    const balloons = layout.items.filter((i) => i.kind === "speech" && i.panel === 8);
    expect(balloons.length).toBe(2);
    for (const b of balloons) for (const face of Object.values(p8.faces)) expect(inter(b.rect, face!)).toBe(0);
    expect(layout.chapter?.big).toBe("HALF-PACKED BAGS");
  });

  test("phones: one full-width panel per line in reading order, page breaks kept, text at the webtoon size", () => {
    expect(mangaLayoutWidth(690)).toBe(MANGA_PAGE_WIDTH);
    const width = mangaLayoutWidth(390);
    expect(width).toBeLessThan(MANGA_PAGE_WIDTH);
    const sb = storyboard();
    const layout = layoutManga(sb, images(sb), { width });
    expect(layout.width).toBe(width);
    expect(layout.pages?.length).toBe(3);
    expect(layout.panels.map((p) => p.id)).toEqual(IMPS.map((_, i) => i + 1));
    const ys = layout.panels.map((p) => p.rect[1]);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    for (const p of layout.panels) expect(p.rect[2] - p.rect[0]).toBe(width - 20);
    // page 2 starts below page 1's sheet
    expect(layout.panels[4]!.rect[1]).toBeGreaterThan(layout.pages![0]![3]);
    const sizes = layout.items.flatMap((i) => (i.kind === "speech" ? [i.fontSize!] : []));
    expect(Math.min(...sizes) * (390 / width)).toBeGreaterThanOrEqual(11.9);
    expect(readingOrderErrors(layout)).toEqual([]);
  });
});
