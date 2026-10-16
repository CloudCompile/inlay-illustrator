/**
 * Live-DOM webtoon strip (experimental webtoon mode): layout JSON (src/backend/webtoon/layout.ts) -> absolutely
 * positioned panels, one SVG layer of balloon shapes, and real text on top (selectable, editable). Drawn at the
 * 690 px design width and scaled to the message width by the caller (`setStripScale`).
 * Per panel: reroll button; clicking a text item opens a small editor.
 */
import type { LayoutItem, SfxItem, WebtoonPanelState, WebtoonStripView } from "../../../shared/contract/webtoon.js";
import { balloonShapes } from "./svg-shapes.js";

export const STRIP_WIDTH = 690;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface StripHandlers {
  onReroll(panelId: string): void;
  onEditText(item: { panelId: string; textIndex: number; text: string }): void;
}

export interface StripRenderOptions {
  /** Panels with a reroll running (button disabled + spinner). */
  busyPanels: ReadonlySet<string>;
  /** The whole strip job is running (no rerolls). */
  stripBusy: boolean;
  labels: { reroll: string; drawing: string; failed: string; pending: string; edit: string };
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, style: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  for (const [k, v] of Object.entries(style)) node.style.setProperty(k, v);
  return node;
}

function textKey(item: Pick<LayoutItem, "panelId" | "textIndex">): string {
  return `${item.panelId}:${item.textIndex}`;
}

function panelImage(doc: Document, state: WebtoonPanelState | undefined, panel: { w: number; h: number; crop: [number, number, number, number] }, opts: StripRenderOptions): HTMLElement {
  const take = state && state.selected >= 0 ? state.takes[state.selected] : undefined;
  if (take) {
    const visH = panel.h / Math.max(0.0001, panel.crop[3] - panel.crop[1]);
    const img = el(doc, "img", "ii-wt-img", { width: px(panel.w), height: px(visH), "margin-top": px(-panel.crop[1] * visH) });
    img.src = take.url;
    img.alt = "";
    img.draggable = false;
    img.loading = "lazy";
    return img;
  }
  const placeholder = el(doc, "div", "ii-wt-placeholder");
  placeholder.setAttribute("data-ii-wt-state", state?.status ?? "pending");
  placeholder.textContent = state?.status === "error" ? `${opts.labels.failed}${state.error ? `: ${state.error}` : ""}` : opts.stripBusy ? opts.labels.drawing : opts.labels.pending;
  return placeholder;
}

function textNode(doc: Document, item: LayoutItem, handlers: StripHandlers, label: string): HTMLElement {
  let node: HTMLElement;
  if (item.kind === "speech" || item.kind === "thought") {
    const box = item.textBox;
    node = el(doc, "div", item.kind === "thought" ? "ii-wt-bt ii-wt-th" : "ii-wt-bt", { left: px(box.x), top: px(box.y), width: px(box.w), height: px(box.h) });
  } else if (item.kind === "narration") {
    const [x0, y0, x1, y1] = item.rect;
    node = el(doc, "div", "ii-wt-narr", { left: px(x0), top: px(y0), width: px(x1 - x0), height: px(y1 - y0) });
  } else {
    const sfx = item as SfxItem;
    const [x0, y0] = sfx.rect;
    node = el(doc, "div", "ii-wt-sfx", { left: px(x0), top: px(y0), "font-size": px(sfx.size), color: sfx.color, transform: `rotate(${sfx.rot}deg)` });
  }
  item.lines.forEach((line, i) => {
    if (i) node.appendChild(doc.createElement("br"));
    node.appendChild(doc.createTextNode(line));
  });
  node.setAttribute("data-ii-wt-text", textKey(item));
  node.title = label;
  node.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handlers.onEditText({ panelId: item.panelId, textIndex: item.textIndex, text: item.text });
  });
  return node;
}

/** Build the strip at design size (690 x layout.height). Returns null while the storyboard is not planned. */
export function renderStrip(doc: Document, view: WebtoonStripView, handlers: StripHandlers, opts: StripRenderOptions): HTMLElement | null {
  const layout = view.layout;
  if (!layout) return null;
  const canvas = el(doc, "div", "ii-wt-canvas", { width: px(STRIP_WIDTH), height: px(layout.height) });
  canvas.setAttribute("data-ii-wt-revision", String(view.revision));
  for (const panel of layout.panels) {
    const box = el(doc, "div", "ii-wt-panel", { left: px(panel.x), top: px(panel.y), width: px(panel.w), height: px(panel.h) });
    box.setAttribute("data-ii-wt-panel", panel.panelId);
    if (panel.mask) box.setAttribute("data-ii-wt-mask", panel.mask);
    box.appendChild(panelImage(doc, view.panels[panel.panelId], panel, opts));
    canvas.appendChild(box);
  }
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ii-wt-balloons");
  svg.setAttribute("width", String(STRIP_WIDTH));
  svg.setAttribute("height", String(layout.height));
  svg.setAttribute("viewBox", `0 0 ${STRIP_WIDTH} ${layout.height}`);
  for (const item of layout.items) {
    if (item.kind !== "speech" && item.kind !== "thought") continue;
    const shapes = balloonShapes(item);
    for (const shape of [...shapes.outline, ...shapes.fill]) {
      const node = doc.createElementNS(SVG_NS, shape.tag);
      for (const [k, v] of Object.entries(shape.attrs)) node.setAttribute(k, String(v));
      svg.appendChild(node);
    }
  }
  canvas.appendChild(svg);
  for (const panel of layout.panels) {
    if (!panel.title) continue;
    const title = el(doc, "div", "ii-wt-title", { top: px(panel.title.y) });
    if (panel.title.small) title.appendChild(Object.assign(el(doc, "div", "ii-wt-t1"), { textContent: panel.title.small }));
    title.appendChild(Object.assign(el(doc, "div", "ii-wt-t2"), { textContent: panel.title.big }));
    title.appendChild(el(doc, "div", "ii-wt-bar"));
    canvas.appendChild(title);
  }
  for (const item of layout.items) canvas.appendChild(textNode(doc, item, handlers, opts.labels.edit));
  for (const panel of layout.panels) {
    const busy = opts.busyPanels.has(panel.panelId);
    const button = el(doc, "button", "ii-wt-reroll", { left: px(panel.x + panel.w - 44), top: px(panel.y + 8) });
    button.type = "button";
    button.title = opts.labels.reroll;
    button.setAttribute("aria-label", opts.labels.reroll);
    button.setAttribute("data-ii-wt-reroll", panel.panelId);
    if (busy) button.setAttribute("data-ii-wt-busy", "true");
    button.disabled = busy || opts.stripBusy || !view.panels[panel.panelId];
    button.textContent = "\u21bb";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) handlers.onReroll(panel.panelId);
    });
    canvas.appendChild(button);
  }
  return canvas;
}

/** Scale the 690 px canvas to the frame width (the frame keeps the aspect ratio through CSS). */
export function setStripScale(frame: HTMLElement, canvas: HTMLElement): void {
  const width = frame.clientWidth || STRIP_WIDTH;
  canvas.style.transform = `scale(${Math.min(1.5, width / STRIP_WIDTH)})`;
}
