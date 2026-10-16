/**
 * Live-DOM webtoon strip (experimental webtoon mode): layout JSON (src/backend/webtoon/layout.ts) -> absolutely
 * positioned panels, one SVG layer of balloon shapes, and real text on top (selectable, editable). Drawn at the
 * layout width (`layout.width`, laid out for the shown width) and scaled to the frame width by the caller (`setStripScale`).
 * Per panel, shown while the pointer is over that panel: reroll button and, when the panel has older takes, previous /
 * next take arrows, in one row placed clear of text boxes (left edge first in the phone layout). Frame-break panels draw their character cut-out over the frame line.
 * Clicking a text item opens a small editor.
 */
import { STRIP_WIDTH, type LaidItem, type PanelLayout, type SfxItem, type TitleItem, type WebtoonPanelState, type WebtoonStripView } from "../../../shared/contract/webtoon.js";
import { balloonShapes } from "./svg-shapes.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface StripHandlers {
  onReroll(panelId: string): void;
  onSelectTake(panelId: string, take: number): void;
  onEditText(item: { panelId: string; textIndex: number; text: string }): void;
}

export interface StripRenderOptions {
  /** Panels with a reroll running (button disabled + spinner). */
  busyPanels: ReadonlySet<string>;
  /** The whole strip job is running (no rerolls). */
  stripBusy: boolean;
  labels: { reroll: string; previousTake: string; nextTake: string; drawing: string; failed: string; pending: string; edit: string };
}

const px = (n: number) => `${Math.round(n * 100) / 100}px`;

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, style: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  for (const [k, v] of Object.entries(style)) node.style.setProperty(k, v);
  return node;
}

/** The image of a panel (or its cut-out) at the panel's crop, drawn from the top-left of `panel.rect`. */
function croppedImage(doc: Document, src: string, panel: PanelLayout): HTMLImageElement {
  const w = panel.rect[2] - panel.rect[0];
  const visH = (panel.rect[3] - panel.rect[1]) / Math.max(0.0001, panel.crop[3] - panel.crop[1]);
  const img = el(doc, "img", "ii-wt-img", { width: px(w), height: px(visH), "margin-top": px(-panel.crop[1] * visH) });
  img.src = src;
  img.alt = "";
  img.draggable = false;
  img.loading = "lazy";
  return img;
}

function panelImage(doc: Document, state: WebtoonPanelState | undefined, panel: PanelLayout, opts: StripRenderOptions): HTMLElement {
  const take = state && state.selected >= 0 ? state.takes[state.selected] : undefined;
  if (take) return croppedImage(doc, take.url, panel);
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

/** Panel tool buttons, strip px (scaled with the strip). */
export const TOOL_SIZE = { desktop: 36, narrow: 48, gap: 6, inset: 8 };

type Box = [number, number, number, number];
const overlaps = (a: Box, b: Box, pad: number) => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;

/** Top-left of the tool row in strip px: the first spot inside the frame that touches no text box (else the first spot). */
export function toolsSpot(frame: Box, count: number, size: number, narrow: boolean, textRects: readonly Box[]): [number, number] {
  const w = count * size + (count - 1) * TOOL_SIZE.gap, h = size, m = TOOL_SIZE.inset;
  const [x0, y0, x1, y1] = frame;
  const left = x0 + m, right = x1 - m - w, top = y0 + m, bottom = y1 - m - h, mid = (y0 + y1 - h) / 2;
  const spots: Array<[number, number]> = narrow
    ? [[left, mid], [left, top], [left, bottom], [right, top], [right, bottom]]
    : [[right, top], [left, top], [right, bottom], [left, bottom], [right, mid], [left, mid]];
  return spots.find(([x, y]) => !textRects.some((r) => overlaps([x, y, x + w, y + h], r, 6))) ?? spots[0]!;
}

/** Build the strip at design size (690 x layout.height). Returns null while the storyboard is not planned. */
export function renderStrip(doc: Document, view: WebtoonStripView, handlers: StripHandlers, opts: StripRenderOptions): HTMLElement | null {
  const layout = view.layout;
  if (!layout) return null;
  const canvas = el(doc, "div", "ii-wt-canvas", { width: px(layout.width), height: px(layout.height) });
  canvas.setAttribute("data-ii-wt-revision", String(view.revision));
  if (layout.width < STRIP_WIDTH) canvas.setAttribute("data-ii-wt-narrow", "true");
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
  // Frame-break: the character cut-out over its panel, clipped to the image rect only, so the head crosses the frame line.
  for (const panel of layout.panels) {
    if (!panel.cutout) continue;
    const [x0, y0, x1, y1] = panel.rect;
    const box = el(doc, "div", "ii-wt-cutout", { left: px(x0), top: px(y0), width: px(x1 - x0), height: px(y1 - y0) });
    box.setAttribute("data-ii-wt-cutout", String(panel.id));
    box.appendChild(croppedImage(doc, panel.cutout.src, panel));
    canvas.appendChild(box);
  }
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ii-wt-balloons");
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));
  svg.setAttribute("viewBox", `0 0 ${layout.width} ${layout.height}`);
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
      const title = el(doc, "div", "ii-wt-title", { top: px(item.y), width: px(layout.width) });
      if (item.small) title.appendChild(Object.assign(el(doc, "div", "ii-wt-t1"), { textContent: item.small }));
      title.appendChild(Object.assign(el(doc, "div", "ii-wt-t2"), { textContent: item.big }));
      title.appendChild(el(doc, "div", "ii-wt-bar"));
      canvas.appendChild(title);
    } else canvas.appendChild(textNode(doc, item, handlers, opts.labels.edit));
  }
  // Panel tools (reroll, take arrows) in one row, at the first frame spot clear of text boxes; the phone layout tries the left
  // edge first (Lumiverse's fixed side tabs cover the right edge there).
  const narrow = layout.width < STRIP_WIDTH;
  const size = narrow ? TOOL_SIZE.narrow : TOOL_SIZE.desktop;
  const textRects = layout.items.flatMap((item) => ("rect" in item ? [item.rect] : []));
  for (const panel of layout.panels) {
    const panelId = String(panel.id);
    const state = view.panels[panelId];
    const [fx0, fy0, fx1, fy1] = panel.frame;
    const controls = el(doc, "div", "ii-wt-controls", { left: px(fx0), top: px(fy0), width: px(fx1 - fx0), height: px(fy1 - fy0) });
    controls.setAttribute("data-ii-wt-controls", panelId);
    const tools = el(doc, "div", "ii-wt-tools");
    const button = (className: string, label: string, text: string, disabled: boolean, onClick: () => void) => {
      const node = el(doc, "button", className);
      node.type = "button";
      node.title = label;
      node.setAttribute("aria-label", label);
      node.disabled = disabled;
      node.textContent = text;
      node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!node.disabled) onClick();
      });
      return tools.appendChild(node);
    };
    const busy = opts.busyPanels.has(panelId);
    const reroll = button("ii-wt-reroll", opts.labels.reroll, "\u21bb", busy || opts.stripBusy || !state, () => handlers.onReroll(panelId));
    reroll.setAttribute("data-ii-wt-reroll", panelId);
    if (busy) reroll.setAttribute("data-ii-wt-busy", "true");
    const takes = state?.takes.length ?? 0;
    if (state && takes > 1) {
      const at = `${state.selected + 1}/${takes}`;
      const locked = busy || opts.stripBusy;
      button("ii-wt-take ii-wt-take--prev", `${opts.labels.previousTake} (${at})`, "\u2039", locked || state.selected <= 0, () => handlers.onSelectTake(panelId, state.selected - 1))
        .setAttribute("data-ii-wt-take", "prev");
      button("ii-wt-take ii-wt-take--next", `${opts.labels.nextTake} (${at})`, "\u203a", locked || state.selected >= takes - 1, () => handlers.onSelectTake(panelId, state.selected + 1))
        .setAttribute("data-ii-wt-take", "next");
    }
    const [x, y] = toolsSpot([fx0, fy0, fx1, fy1], tools.children.length, size, narrow, textRects);
    for (const [k, v] of Object.entries({ left: px(x - fx0), top: px(y - fy0) })) tools.style.setProperty(k, v);
    controls.appendChild(tools);
    canvas.appendChild(controls);
  }
  // Controls of the panel under the pointer (panel image, its text items, or the controls themselves).
  let hovered: Element | null = null;
  const hover = (next: Element | null) => {
    if (next === hovered) return;
    hovered?.removeAttribute("data-ii-wt-hover");
    next?.setAttribute("data-ii-wt-hover", "true");
    hovered = next;
  };
  canvas.addEventListener("pointerover", (event) => {
    const hit = (event.target as Element | null)?.closest?.("[data-ii-wt-panel], [data-ii-wt-text], [data-ii-wt-controls]");
    const id = hit?.getAttribute("data-ii-wt-panel") ?? hit?.getAttribute("data-ii-wt-controls") ?? hit?.getAttribute("data-ii-wt-text")?.split(":")[0];
    hover(id ? canvas.querySelector(`[data-ii-wt-controls="${id}"]`) : null);
  });
  canvas.addEventListener("pointerleave", () => hover(null));
  return canvas;
}

/** Scale the canvas (`layoutWidth` strip px) to the frame width (the frame keeps the aspect ratio through CSS). */
export function setStripScale(frame: HTMLElement, canvas: HTMLElement, layoutWidth: number): void {
  const width = frame.clientWidth || layoutWidth;
  canvas.style.transform = `scale(${Math.min(1.5, width / layoutWidth)})`;
}
