import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { WebtoonStripView } from "../../../shared/contract/webtoon.js";
import { layoutStrip, type PanelImage } from "../../../backend/webtoon/layout.js";
import type { Storyboard } from "../../../backend/webtoon/storyboard-schema.js";
import fixture from "../../../backend/webtoon/__fixtures__/storyboard-a2.json" with { type: "json" };
import { renderStrip } from "./strip-dom.js";

const win = new Window({ url: "http://localhost/" });
const doc = win.document as unknown as Document;
const labels = { reroll: "Redraw", drawing: "Drawing", failed: "Failed", pending: "Pending", edit: "Edit" };

function view(): WebtoonStripView {
  const storyboard = fixture as unknown as Storyboard;
  const sizes: Record<string, PanelImage> = {};
  for (const p of storyboard.panels) if (p.kind === "image") sizes[String(p.id)] = { width: Number(p.size.split("x")[0]), height: Number(p.size.split("x")[1]) };
  const layout = layoutStrip(storyboard, sizes);
  const panels: WebtoonStripView["panels"] = {};
  for (const [i, lp] of layout.panels.entries()) {
    const p = { panelId: String(lp.id) };
    panels[p.panelId] = i === 0
      ? { panelId: p.panelId, status: "done", selected: 0, takes: [{ imageId: "img-1", url: "/api/v1/image-gen/results/img-1", seed: "1", width: 832, height: 1216, createdAt: 0 }] }
      : i === 1 ? { panelId: p.panelId, status: "error", selected: -1, takes: [], error: "429" } : { panelId: p.panelId, status: "pending", selected: -1, takes: [] };
  }
  return { chatId: "c", messageKey: "illustration:m@0", status: "generating", revision: 3, title: "T", layout, panels, updatedAt: 0 };
}

describe("webtoon strip DOM", () => {
  test("layout JSON -> panels, balloon shapes, real text, controls", () => {
    const v = view();
    const calls: string[] = [];
    const ids = v.layout!.panels.map((p) => String(p.id));
    const canvas = renderStrip(doc, v, { onReroll: (id) => calls.push(`reroll:${id}`), onEditText: (t) => calls.push(`edit:${t.panelId}:${t.textIndex}:${t.text}`) }, { busyPanels: new Set([ids[2]!]), stripBusy: false, labels })!;
    expect(canvas.style.height).toBe(`${v.layout!.height}px`);
    const panels = canvas.querySelectorAll("[data-ii-wt-panel]");
    expect(panels.length).toBe(v.layout!.panels.length);
    expect(panels[0]!.querySelector("img")!.getAttribute("src")).toBe("/api/v1/image-gen/results/img-1");
    expect(panels[1]!.textContent).toBe("Failed: 429");
    expect(panels[2]!.textContent).toBe("Pending");
    const texts = canvas.querySelectorAll("[data-ii-wt-text]");
    const textItems = v.layout!.items.flatMap((i) => (i.kind === "title" ? [] : [i]));
    expect(texts.length).toBe(textItems.length);
    const balloons = v.layout!.items.filter((i) => i.kind === "speech" || i.kind === "thought").length;
    expect(canvas.querySelector("svg")!.children.length).toBeGreaterThan(balloons);
    const first = textItems[0]!;
    expect(texts[0]!.textContent).toBe(first.kind === "sfx" ? first.text : first.lines.join(""));
    (texts[0] as HTMLElement).click();
    expect(calls).toEqual([`edit:${first.panel}:${first.textIndex}:${first.text}`]);
    const buttons = [...canvas.querySelectorAll("[data-ii-wt-reroll]")] as HTMLButtonElement[];
    expect(buttons.map((b) => b.disabled)).toEqual(v.layout!.panels.map((_p, i) => i === 2));
    buttons[0]!.click();
    buttons[2]!.click();
    expect(calls.at(-1)).toBe(`reroll:${ids[0]}`);
  });

  test("no layout yet -> nothing to draw", () => {
    expect(renderStrip(doc, { ...view(), layout: null }, { onReroll() {}, onEditText() {} }, { busyPanels: new Set(), stripBusy: true, labels })).toBeNull();
  });
});
