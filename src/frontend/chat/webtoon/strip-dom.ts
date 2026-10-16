/**
 * Live-DOM webtoon strip (experimental webtoon mode): layout JSON (src/backend/webtoon/layout.ts) -> absolutely
 * positioned panels, one SVG layer of balloon shapes, and real text on top (selectable, editable). Drawn at the
 * 690 px design width and scaled to the message width by the caller (`setStripScale`).
 * Per panel: reroll button; clicking a text item opens a small editor.
 */
import type { LaidItem, PanelLayout, SfxItem, TitleItem, WebtoonPanelState, WebtoonStripView } from "../../../shared/contract/webtoon.js";
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

function panelImage(doc: Document, state: WebtoonPanelState | undefined, panel: PanelLayout, opts: StripRenderOptions): HTMLElement {
  const take = state && state.selected >= 0 ? state.takes[state.selected] : undefined;
  if (take) {
    const w = panel.rect[2] - panel.rect[0];
    const visH = (panel.rect[3] - panel.rect[1]) / Math.max(0.0001, panel.crop[3] - panel.crop[1]);
    const img = el(doc, "img", "ii-wt-img", { width: px(w), height: px(visH), "margin-top": px(-panel.crop[1] * visH) });
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

type TextItem = Exclude<LaidItem, TitleItem>;

function textNode(doc: Document, item: TextItem, handlers: StripHandlers, label: string): HTMLElement {
  let node: HTMLElement;
  if (item.kind === "speech" || item.kind === "thought") {
    node = el(doc, "div", item.kind === "thought" ? "ii-wt-bt ii-wt-th" : "ii-wt-bt", {
      left: px(item.cx - item.textW / 2 - 4), top: px(item.cy - item.textH / 2), width: px(item.textW + 8), height: px(item.textH),
    });
  } else if (item.kind === "narration") {
    const [x0, y0, x1, y1] = item.rect;
    node = el(doc, "div", "ii-wt-narr", { left: px(x0), top: px(y0), width: px(x1 - x0), height: px(y1 - y0) });
  } else {
    const sfx = item as SfxItem;
    const w = sfx.rect[2] - sfx.rect[0];
    node = el(doc, "div", "ii-wt-sfx", { left: px(sfx.cx - w / 2), top: px(sfx.cy - sfx.size / 2), width: px(w), "font-size": px(sfx.size), color: sfx.color, transform: `rotate(${sfx.rot}deg)` });
  }
  const lines = item.kind === "sfx" ? [item.text] : item.lines;
  lines.forEach((line, i) => {
    if (i) node.appendChild(doc.createElement("br"));
    node.appendChild(doc.createTextNode(line));
  });
  const panelId = String(item.panel);
  node.setAttribute("data-ii-wt-text", `${panelId}:${item.textIndex}`);
  node.title = label;
  node.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    handlers.onEditText({ panelId, textIndex: item.textIndex, text: item.text });
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
    const [x0, y0, x1, y1] = panel.rect;
    const box = el(doc, "div", "ii-wt-panel", { left: px(x0), top: px(y0), width: px(x1 - x0), height: px(y1 - y0) });
    box.setAttribute("data-ii-wt-panel", String(panel.id));
    if (panel.fade) box.setAttribute("data-ii-wt-fade", panel.fade);
    if (panel.frameBreak) {
      const [fx0, fy0, fx1, fy1] = panel.frame;
      box.style.setProperty("clip-path", `inset(${px(fy0 - y0)} ${px(x1 - fx1)} ${px(y1 - fy1)} ${px(fx0 - x0)})`);
    }
    box.appendChild(panelImage(doc, view.panels[String(panel.id)], panel, opts));
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
  for (const item of layout.items) {
    if (item.kind === "title") {
      const title = el(doc, "div", "ii-wt-title", { top: px(item.y) });
      if (item.small) title.appendChild(Object.assign(el(doc, "div", "ii-wt-t1"), { textContent: item.small }));
      title.appendChild(Object.assign(el(doc, "div", "ii-wt-t2"), { textContent: item.big }));
      title.appendChild(el(doc, "div", "ii-wt-bar"));
      canvas.appendChild(title);
    } else canvas.appendChild(textNode(doc, item, handlers, opts.labels.edit));
  }
  for (const panel of layout.panels) {
    const panelId = String(panel.id);
    const busy = opts.busyPanels.has(panelId);
    const button = el(doc, "button", "ii-wt-reroll", { left: px(panel.frame[2] - 44), top: px(panel.frame[1] + 8) });
    button.type = "button";
    button.title = opts.labels.reroll;
    button.setAttribute("aria-label", opts.labels.reroll);
    button.setAttribute("data-ii-wt-reroll", panelId);
    if (busy) button.setAttribute("data-ii-wt-busy", "true");
    button.disabled = busy || opts.stripBusy || !view.panels[panelId];
    button.textContent = "\u21bb";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) handlers.onReroll(panelId);
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
