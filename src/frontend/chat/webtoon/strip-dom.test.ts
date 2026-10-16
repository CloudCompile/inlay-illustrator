import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { WebtoonStripView } from "../../../shared/contract/webtoon.js";
import { layoutStrip, type LayoutInput } from "../../../backend/webtoon/layout.js";
import fixture from "../../../backend/webtoon/__fixtures__/storyboard-a.json" with { type: "json" };
import { renderStrip } from "./strip-dom.js";

const win = new Window({ url: "http://localhost/" });
const doc = win.document as unknown as Document;
const labels = { reroll: "Redraw", drawing: "Drawing", failed: "Failed", pending: "Pending", edit: "Edit" };

function view(): WebtoonStripView {
  const layout = layoutStrip({ storyboard: fixture as unknown as LayoutInput["storyboard"], imageSizes: {} });
  const panels: WebtoonStripView["panels"] = {};
  for (const [i, p] of layout.panels.entries()) {
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
    const canvas = renderStrip(doc, v, { onReroll: (id) => calls.push(`reroll:${id}`), onEditText: (t) => calls.push(`edit:${t.panelId}:${t.textIndex}:${t.text}`) }, { busyPanels: new Set([v.layout!.panels[2]!.panelId]), stripBusy: false, labels })!;
    expect(canvas.style.height).toBe(`${v.layout!.height}px`);
    const panels = canvas.querySelectorAll("[data-ii-wt-panel]");
    expect(panels.length).toBe(v.layout!.panels.length);
    expect(panels[0]!.querySelector("img")!.getAttribute("src")).toBe("/api/v1/image-gen/results/img-1");
    expect(panels[1]!.textContent).toBe("Failed: 429");
    expect(panels[2]!.textContent).toBe("Pending");
    const texts = canvas.querySelectorAll("[data-ii-wt-text]");
    expect(texts.length).toBe(v.layout!.items.length);
    const balloons = v.layout!.items.filter((i) => i.kind === "speech" || i.kind === "thought").length;
    expect(canvas.querySelector("svg")!.children.length).toBeGreaterThan(balloons);
    const first = v.layout!.items[0]!;
    expect(texts[0]!.textContent).toBe(first.lines.join(""));
    (texts[0] as HTMLElement).click();
    expect(calls).toEqual([`edit:${first.panelId}:${first.textIndex}:${first.text}`]);
    const buttons = [...canvas.querySelectorAll("[data-ii-wt-reroll]")] as HTMLButtonElement[];
    expect(buttons.map((b) => b.disabled)).toEqual(v.layout!.panels.map((_p, i) => i === 2));
    buttons[0]!.click();
    buttons[2]!.click();
    expect(calls.at(-1)).toBe(`reroll:${v.layout!.panels[0]!.panelId}`);
    expect(canvas.querySelector(".ii-wt-title")?.textContent).toContain(v.layout!.panels[0]!.title?.big ?? "");
  });

  test("no layout yet -> nothing to draw", () => {
    expect(renderStrip(doc, { ...view(), layout: null }, { onReroll() {}, onEditText() {} }, { busyPanels: new Set(), stripBusy: true, labels })).toBeNull();
  });
});
