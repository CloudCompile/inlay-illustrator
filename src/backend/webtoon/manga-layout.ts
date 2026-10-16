/**
 * Manga page layout (pure; manga prototype `manga-proto/scripts/layout.ts`, ported for Inlay).
 * Pages are built from a small library of row templates (2-4 rows, 1-3 cells per row, cells in right-to-left reading
 * order, optional slanted cut); `choosePages` splits the panel sequence into pages by dynamic programming over the panels'
 * importance. Each panel's NovelAI size is the allowed size closest to its cell (`mangaPagePlan`, run right after the planner).
 * `layoutManga` lays the pages out at MANGA_PAGE_WIDTH, or, narrower (phones), one panel per full-width line in reading order
 * with the page breaks kept. Images are cover-fitted into their cells with the crop centred on the heads; balloons sit next to
 * the speaker's head, may cross the cell edge into the gutter, never touch a face, and keep the right-to-left reading order.
 */
import {
  MANGA_PAGE_WIDTH,
  MANGA_SPEECH_PX,
  STRIP_MIN_LAYOUT_WIDTH,
  STRIP_SPEECH_PX,
  STRIP_WIDTH,
  type BalloonItem,
  type ChapterBox,
  type LaidItem,
  type NarrationItem,
  type PanelLayout,
  type Point,
  type Rect,
  type SfxItem,
  type StripLayout,
} from "../../shared/contract/webtoon.js";
import { charGeometry, defaultMeasure, isShout, type FontKind, type PanelImage } from "./layout.js";
import type { ImagePanel, Importance, MangaPage, Storyboard, TextItem } from "./storyboard-schema.js";

/* ---------------------------------------------------------------- templates and page split */

/** A row: height share of the page, cells in reading order (right to left) with width shares, optional slant (the cut between cells moves this share of the row width from top to bottom). */
export interface TemplateRow { h: number; cells: Array<{ w: number; imp: Importance }>; slant?: number }
export interface PageTemplate { id: string; rows: TemplateRow[] }
const S = (w: number) => ({ w, imp: "small" as const });
const N = (w: number) => ({ w, imp: "normal" as const });
const B = (w: number) => ({ w, imp: "big" as const });
export const TEMPLATES: PageTemplate[] = [
  { id: "4a", rows: [{ h: 0.44, cells: [B(1)] }, { h: 0.28, cells: [N(0.5), N(0.5)], slant: 0.06 }, { h: 0.28, cells: [N(1)] }] },
  { id: "4b", rows: [{ h: 0.3, cells: [N(0.55), N(0.45)] }, { h: 0.24, cells: [N(1)] }, { h: 0.46, cells: [B(1)] }] },
  { id: "4c", rows: [{ h: 0.52, cells: [B(0.64), S(0.36)] }, { h: 0.48, cells: [N(0.5), N(0.5)], slant: -0.08 }] },
  { id: "4d", rows: [{ h: 0.3, cells: [N(0.62), S(0.38)] }, { h: 0.48, cells: [B(1)] }, { h: 0.22, cells: [S(1)] }] },
  { id: "5a", rows: [{ h: 0.26, cells: [N(0.6), S(0.4)] }, { h: 0.44, cells: [B(1)] }, { h: 0.3, cells: [N(0.5), N(0.5)], slant: 0.06 }] },
  { id: "5b", rows: [{ h: 0.42, cells: [B(1)] }, { h: 0.22, cells: [S(0.34), S(0.33), S(0.33)] }, { h: 0.36, cells: [N(1)] }] },
  { id: "5c", rows: [{ h: 0.28, cells: [N(0.5), N(0.5)] }, { h: 0.24, cells: [N(1)] }, { h: 0.48, cells: [S(0.34), B(0.66)] }] },
  { id: "5d", rows: [{ h: 0.28, cells: [N(0.6), S(0.4)] }, { h: 0.26, cells: [N(0.5), N(0.5)], slant: 0.06 }, { h: 0.46, cells: [B(1)] }] },
  { id: "6a", rows: [{ h: 0.3, cells: [N(0.5), N(0.5)], slant: -0.05 }, { h: 0.22, cells: [S(0.34), S(0.33), S(0.33)] }, { h: 0.48, cells: [B(1)] }] },
  { id: "7a", rows: [{ h: 0.25, cells: [N(0.5), N(0.5)] }, { h: 0.19, cells: [S(0.34), S(0.33), S(0.33)] }, { h: 0.56, cells: [N(0.38), B(0.62)] }] },
];
const templateById = new Map(TEMPLATES.map((t) => [t.id, t]));
export const templateSeq = (t: PageTemplate): Importance[] => t.rows.flatMap((r) => r.cells.map((c) => c.imp));

/** Cost of a panel of one importance in a cell of another (a big beat shrunk to a small cell costs most). */
const COST: Record<Importance, Record<Importance, number>> = {
  small: { small: 0, normal: 1, big: 3 },
  normal: { small: 1, normal: 0, big: 1.5 },
  big: { small: 4, normal: 2, big: 0 },
};
/** Per page: fewer, fuller pages are preferred. */
const PAGE_COST = 0.6;

/** Split the importance sequence into pages and pick a template per page (dynamic programming; every count >= 4 has a split). */
export function choosePages(imps: readonly Importance[], templates: readonly PageTemplate[] = TEMPLATES): Array<{ template: PageTemplate; start: number; cost: number }> {
  const n = imps.length;
  const best = Array.from({ length: n + 1 }, () => ({ cost: Infinity, prev: -1, t: null as PageTemplate | null }));
  best[0]!.cost = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(best[i]!.cost)) continue;
    for (const t of templates) {
      const seq = templateSeq(t);
      if (i + seq.length > n) continue;
      const c = seq.reduce((sum, imp, k) => sum + COST[imps[i + k]!][imp], PAGE_COST);
      const j = i + seq.length;
      if (best[i]!.cost + c < best[j]!.cost) best[j] = { cost: best[i]!.cost + c, prev: i, t };
    }
  }
  if (!Number.isFinite(best[n]!.cost)) throw new Error(`No page split for ${n} panels.`);
  const out: Array<{ template: PageTemplate; start: number; cost: number }> = [];
  for (let j = n; j > 0; j = best[j]!.prev) out.unshift({ template: best[j]!.t!, start: best[j]!.prev, cost: best[j]!.cost - best[best[j]!.prev]!.cost });
  return out;
}

/* ---------------------------------------------------------------- page geometry */

export interface Cell { poly: Point[]; bbox: Rect; imp: Importance }
/** Page in layout px (1:1.414), margins, gutters between cells of a row and between rows; gap between pages in the page view. */
export const PAGE = { W: MANGA_PAGE_WIDTH, H: 1556, marginX: 56, marginTop: 60, marginBottom: 70, gutterX: 14, gutterY: 24, gap: 40 };

/** Rows (px) -> cell polygons, in reading order (right to left within a row). */
function rowCells(rows: Array<{ y: number; h: number; row: TemplateRow }>, x0: number, x1: number, gutterX: number): Cell[] {
  const cells: Cell[] = [];
  for (const { y, h, row } of rows) {
    const W = x1 - x0;
    const sl = (row.slant ?? 0) * W;
    let right = x1;
    row.cells.forEach((c, k) => {
      const last = k === row.cells.length - 1;
      const cut = right - c.w * W; // left edge at mid height
      const rTop = k === 0 ? x1 : right + sl / 2 - gutterX / 2, rBot = k === 0 ? x1 : right - sl / 2 - gutterX / 2;
      const lTop = last ? x0 : cut + sl / 2 + gutterX / 2, lBot = last ? x0 : cut - sl / 2 + gutterX / 2;
      const poly: Point[] = [[lTop, y], [rTop, y], [rBot, y + h], [lBot, y + h]];
      const xs = poly.map((p) => p[0]);
      cells.push({ poly, bbox: [Math.min(...xs), y, Math.max(...xs), y + h], imp: c.imp });
      right = cut;
    });
  }
  return cells;
}

/** Cells of one page whose top edge is at `top`. */
export function pageCells(t: PageTemplate, top = 0): Cell[] {
  const avail = PAGE.H - PAGE.marginTop - PAGE.marginBottom - PAGE.gutterY * (t.rows.length - 1);
  let y = top + PAGE.marginTop;
  const rows = t.rows.map((row) => {
    const r = { y, h: row.h * avail, row };
    y += r.h + PAGE.gutterY;
    return r;
  });
  return rowCells(rows, PAGE.marginX, PAGE.W - PAGE.marginX, PAGE.gutterX);
}

export const NAI_SIZES: Array<[number, number]> = [[1600, 640], [1472, 704], [1216, 832], [1024, 1024], [832, 1216], [704, 1472], [640, 1600]];
/** The allowed NovelAI size with the aspect closest to the cell (log ratio). */
export function naiSizeFor(bbox: Rect): [number, number] {
  const a = Math.log((bbox[2] - bbox[0]) / (bbox[3] - bbox[1]));
  return NAI_SIZES.reduce((b, s) => (Math.abs(Math.log(s[0] / s[1]) - a) < Math.abs(Math.log(b[0] / b[1]) - a) ? s : b));
}

/** Pages for the planned panels (importance in reading order) and each panel's image size and cell. */
export function mangaPagePlan(panels: ReadonlyArray<{ id: number; importance?: Importance }>): { pages: MangaPage[]; sizes: Record<number, string>; cells: Record<number, Cell> } {
  const split = choosePages(panels.map((p) => p.importance ?? "normal"));
  const sizes: Record<number, string> = {};
  const cells: Record<number, Cell> = {};
  const pages = split.map(({ template, start }) => {
    const ids = panels.slice(start, start + templateSeq(template).length).map((p) => p.id);
    pageCells(template).forEach((cell, k) => {
      sizes[ids[k]!] = naiSizeFor(cell.bbox).join("x");
      cells[ids[k]!] = cell;
    });
    return { template: template.id, panels: ids };
  });
  return { pages, sizes, cells };
}

/* ---------------------------------------------------------------- layout */

/** Page text sizes (layout px); the phone layout scales them to the webtoon balloon size (STRIP_SPEECH_PX). */
export const TEXT = {
  speech: { size: MANGA_SPEECH_PX, lh: 26 },
  narration: { size: 21, lh: 25 },
  title: { size: 38, small: 20 },
  sfx: { big: 84, normal: 62, small: 46 } as Record<Importance, number>,
};
/** Phone layout: page margin, gutter between panels, panel height between these shares of its width. */
const PHONE = { margin: 10, top: 14, gutter: 16, minH: 0.42, maxH: 1.3, gap: 28 };
/** Frame-break: frame line this far below the cut-out's top (share of the cell height, clamped in px). */
const BREAK = { depth: 0.1, min: 40, max: 110, maxTop: 0.45 };

const inter = (a: Rect, b: Rect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const area = (a: Rect) => Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
const pad = (r: Rect, p: number): Rect => [r[0] - p, r[1] - p, r[2] + p, r[3] + p];
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const centre = (r: Rect): Point => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
const shrink = (r: Rect, k: number): Rect => {
  const [cx, cy] = centre(r);
  return [cx - ((r[2] - r[0]) / 2) * k, cy - ((r[3] - r[1]) / 2) * k, cx + ((r[2] - r[0]) / 2) * k, cy + ((r[3] - r[1]) / 2) * k];
};

/**
 * Reading order inside a panel (right to left, top to bottom): two balloons at about the same height (their vertical ranges
 * overlap by a third) are read right first; otherwise the higher one first. True when `next` would be read before `prev`.
 */
export function readBefore(next: Rect, prev: Rect): boolean {
  const overlap = Math.min(next[3], prev[3]) - Math.max(next[1], prev[1]);
  const sameBand = overlap > Math.min(next[3] - next[1], prev[3] - prev[1]) / 3;
  return sameBand ? centre(next)[0] > centre(prev)[0] : centre(next)[1] < centre(prev)[1];
}

export interface MangaLayoutOptions {
  /** MANGA_PAGE_WIDTH (default) = pages; narrower = the phone layout at that width (360..690). */
  width?: number;
  /** Draw the panels in greyscale (monochrome artist style). */
  grey?: boolean;
  measure?: (text: string, font: FontKind, sizePx: number) => number;
}

interface Slot { panel: ImagePanel; cell: Cell; page: Rect }

/** Lay out a planned manga storyboard (pages from `sb.pages`, else split again from the importance). */
export function layoutManga(sb: Storyboard, images: Record<string, PanelImage>, opts: MangaLayoutOptions = {}): StripLayout {
  const measure = opts.measure ?? defaultMeasure;
  const panels = sb.panels.filter((p): p is ImagePanel => p.kind === "image");
  const byId = new Map(panels.map((p) => [p.id, p]));
  const pages: MangaPage[] = sb.pages?.length ? sb.pages : mangaPagePlan(panels).pages;
  const phone = (opts.width ?? MANGA_PAGE_WIDTH) < MANGA_PAGE_WIDTH;
  const W = phone ? clamp(Math.round(opts.width!), STRIP_MIN_LAYOUT_WIDTH, STRIP_WIDTH) : MANGA_PAGE_WIDTH;
  const ts = phone ? STRIP_SPEECH_PX / MANGA_SPEECH_PX : 1;
  const sfxScale = phone ? clamp(W / 760, 0.6, 0.9) : 1;
  const log: string[] = [];
  const slots: Slot[][] = [];
  const pageRects: Rect[] = [];
  let y = 0;
  for (const page of pages) {
    const list = page.panels.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    if (!list.length) continue;
    if (pageRects.length) y += phone ? PHONE.gap : PAGE.gap;
    if (!phone) {
      const template = templateById.get(page.template);
      const cells = template && templateSeq(template).length === list.length ? pageCells(template, y) : null;
      if (!cells) { log.push(`page ${pageRects.length + 1}: unknown template ${page.template}`); continue; }
      const rect: Rect = [0, y, W, y + PAGE.H];
      slots.push(list.map((panel, k) => ({ panel, cell: cells[k]!, page: rect })));
      pageRects.push(rect);
      y += PAGE.H;
    } else {
      const top = y;
      const cells: Cell[] = [];
      let cy = y + PHONE.top;
      const w = W - 2 * PHONE.margin;
      for (const panel of list) {
        const [iw, ih] = imageSize(panel, images);
        const h = Math.round(clamp((w * ih) / iw, PHONE.minH * w, PHONE.maxH * w));
        const bbox: Rect = [PHONE.margin, cy, W - PHONE.margin, cy + h];
        cells.push({ poly: [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]], bbox, imp: panel.importance ?? "normal" });
        cy += h + PHONE.gutter;
      }
      y = cy - PHONE.gutter + PHONE.top;
      const rect: Rect = [0, top, W, y];
      slots.push(list.map((panel, k) => ({ panel, cell: cells[k]!, page: rect })));
      pageRects.push(rect);
    }
  }
  const out: PageContext["out"] = { panels: [], items: [] };
  const first = slots[0]?.[0]?.panel.id;
  for (const page of slots) layoutPage(page, images, { measure, ts, sfxScale, title: sb.title, titlePanel: first, log, out });
  return { width: W, height: Math.round(y), panels: out.panels, items: out.items, log, format: "manga", pages: pageRects, ...(opts.grey ? { grey: true } : {}), ...(out.chapter ? { chapter: out.chapter } : {}) };
}

function imageSize(panel: ImagePanel, images: Record<string, PanelImage>): [number, number] {
  const img = images[String(panel.id)];
  if (img?.width && img.height) return [img.width, img.height];
  const [w, h] = String(panel.size).split("x").map(Number);
  return [w || 1024, h || 1024];
}

interface PageContext {
  measure: NonNullable<MangaLayoutOptions["measure"]>;
  ts: number;
  sfxScale: number;
  title: string;
  titlePanel: number | undefined;
  log: string[];
  out: { panels: PanelLayout[]; items: LaidItem[]; chapter?: ChapterBox };
}

/** The polygon with its top edge moved down to `top` (along the left and right edges). */
function lowerTop(poly: Point[], top: number): Point[] {
  const [tl, tr, br, bl] = poly as [Point, Point, Point, Point];
  const at = (a: Point, b: Point): Point => [a[0] + ((b[0] - a[0]) * (top - a[1])) / Math.max(1, b[1] - a[1]), top];
  return [at(tl, bl), at(tr, br), br, bl];
}

function layoutPage(slots: Slot[], images: Record<string, PanelImage>, ctx: PageContext): void {
  const { measure, ts, log } = ctx;
  const allCells = slots.map((s) => s.cell.bbox);
  const blocked: Rect[] = []; // faces and placed text of this page

  const wrap = (text: string, font: FontKind, size: number, maxw: number) => {
    const lines: string[] = [];
    let cur = "";
    for (const w of text.split(/\s+/u).filter(Boolean)) {
      const t = `${cur} ${w}`.trim();
      if (measure(t, font, size) <= maxw || !cur) cur = t;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  slots.forEach(({ panel: p, cell, page }, i) => {
    const img = images[String(p.id)];
    const [iw, ih] = imageSize(p, images);
    const [x0, y0, x1, y1] = cell.bbox;
    const fw = x1 - x0, fh = y1 - y0;
    // cover-fit, the crop centred on the heads (horizontally on their mean, the highest head at 40% of the cell height)
    const geo = new Map(p.nai.characters.map((c) => [c.name, charGeometry(c, iw, ih, img?.faces)]));
    const withFace = [...geo.values()].filter((g) => g.face);
    const s = Math.max(fw / iw, fh / ih);
    const dw = iw * s, dh = ih * s;
    const hx = withFace.length ? withFace.reduce((a, g) => a + g.head[0], 0) / withFace.length : 0.5;
    const hy = withFace.length ? Math.min(...withFace.map((g) => g.head[1])) : 0.4;
    const dx = clamp(x0 + fw / 2 - hx * dw, x1 - dw, x0), dy = clamp(y0 + fh * 0.4 - hy * dh, y1 - dh, y0);
    const crop: [number, number, number, number] = [(x0 - dx) / dw, (y0 - dy) / dh, (x1 - dx) / dw, (y1 - dy) / dh];
    const toPx = (nx: number, ny: number): Point => [dx + nx * dw, dy + ny * dh];
    const heads: Record<string, Point> = {}, faces: Record<string, Rect | null> = {};
    const bodies: Rect[] = [];
    for (const c of p.nai.characters) {
      const g = geo.get(c.name)!;
      heads[c.name] = toPx(...g.head);
      faces[c.name] = g.face ? ([...toPx(g.face[0], g.face[1]), ...toPx(g.face[2], g.face[3])] as Rect) : null;
      if (faces[c.name]) {
        blocked.push(pad(faces[c.name]!, 4));
        const f = faces[c.name]!, bw = (f[2] - f[0]) * 1.6;
        bodies.push([heads[c.name]![0] - bw, f[3], heads[c.name]![0] + bw, toPx(0, Math.min(1, c.y + 0.35))[1]]);
      }
    }
    // frame-break: an action beat with one character's cut-out; the frame's top moves below the head, which crosses it
    let poly = cell.poly;
    let frame: Rect = cell.bbox;
    let frameBreak: PanelLayout["frameBreak"] = null;
    if (img?.cutout && p.beat === "action" && p.nai.characters.length === 1) {
      const bt = toPx(0, img.cutout.bbox.top)[1];
      if (bt > y0 + 0.03 * fh && bt <= y0 + BREAK.maxTop * fh) {
        const top = Math.min(bt + clamp(BREAK.depth * fh, BREAK.min * ts, BREAK.max * ts), y0 + 0.5 * fh);
        poly = lowerTop(cell.poly, top);
        frame = [x0, top, x1, y1];
        frameBreak = "top";
      }
      log.push(`p${p.id}: frame-break ${frameBreak ?? "none (character not near the top)"}`);
    }
    ctx.out.panels.push({ id: p.id, rect: cell.bbox, crop, frame, frameBreak, cutout: frameBreak && img?.cutout ? { src: img.cutout.src } : null, fade: null, heads, faces, clip: poly });

    const local: LaidItem[] = [];
    const inPage = (r: Rect) => r[0] >= page[0] + 4 && r[1] >= page[1] + 4 && r[2] <= page[2] - 4 && r[3] <= page[3] - 4;
    const otherShare = (r: Rect) => allCells.reduce((sum, b, k) => sum + (k === i ? 0 : inter(r, b)), 0) / area(r);

    // chapter title box (first panel of the chapter): top corner, right first
    if (p.id === ctx.titlePanel && ctx.title.trim()) {
      const [a, ...rest] = ctx.title.split(":");
      const big = (rest.length ? rest.join(":") : a!).trim().toUpperCase();
      const small = rest.length ? a!.trim().toUpperCase() : "";
      const size = Math.round(TEXT.title.size * ts), smallSize = Math.round(TEXT.title.small * ts);
      const lines = wrap(big, "sfx", size, Math.min(380 * ts, fw * 0.6));
      const bw = Math.max(...lines.map((l) => measure(l, "sfx", size)), small ? measure(small, "narration", smallSize) : 0) + 40 * ts;
      const bh = lines.length * size * 1.05 + (small ? smallSize * 1.3 : 0) + 26 * ts;
      const m = 12 * ts;
      const spot = [[x1 - bw - m, frame[1] + m], [x0 + m, frame[1] + m], [x0 + m, y1 - bh - m], [x1 - bw - m, y1 - bh - m]]
        .map(([x, yy]) => [x!, yy!, x! + bw, yy! + bh] as Rect)
        .find((r) => inPage(r) && !blocked.some((b) => inter(r, b) > 0)) ?? ([x1 - bw - m, frame[1] + m, x1 - m, frame[1] + m + bh] as Rect);
      blocked.push(pad(spot, 4));
      ctx.out.chapter = { panel: p.id, small, big, rect: spot, fontSize: size };
    }

    // balloons and narration in text order
    const texts = p.text.map((t, k) => ({ t, k }));
    const balloonsTotal = texts.filter(({ t }) => t.type === "speech" || t.type === "thought").length;
    const placeTexts = (bias: number, aspect: number) => {
      const taken: Rect[] = [];
      const items: LaidItem[] = [];
      const balloons: Rect[] = [];
      let violations = 0;
      let nth = 0;
      for (const [j, { t, k }] of texts.entries()) {
        if (t.type === "sfx") continue;
        const next = texts.slice(j + 1).find((x) => x.t.type === "speech" || x.t.type === "thought")?.t;
        const placed = t.type === "narration" ? { item: placeNarration(t, k, taken), violates: false } : placeBalloon(t, k, next, balloonsTotal - 1 - nth++, taken, balloons, bias, aspect);
        if (placed.violates) violations++;
        if (placed.item.kind !== "narration") balloons.push(placed.item.rect);
        items.push(placed.item);
        taken.push(pad(placed.item.rect, 4));
      }
      return { items, violations };
    };

    const placeNarration = (t: TextItem, k: number, taken: Rect[]): NarrationItem => {
      const size = Math.round(TEXT.narration.size * ts), lh = Math.round(TEXT.narration.lh * ts);
      const lines = fitLines(t.text, "narration", size, lh, 3.4, 60 * ts, Math.min(300 * ts, fw * 0.7));
      const tw = Math.max(...lines.map((l) => measure(l, "narration", size)));
      const bw = tw + 36 * ts, bh = lines.length * lh + 24 * ts;
      const corners: Point[] = [[x1 - bw, frame[1]], [x0, frame[1]], [x0, y1 - bh], [x1 - bw, y1 - bh]];
      const straddle: Point[] = [[x1 - bw - 14 * ts, frame[1] - bh / 2], [x0 + 14 * ts, frame[1] - bh / 2], [x0 + 14 * ts, y1 - bh / 2], [x1 - bw - 14 * ts, y1 - bh / 2]];
      const free = (r: Rect) => inPage(r) && !blocked.some((b) => inter(r, b) > 0) && !taken.some((b) => inter(r, b) > 0);
      const rects = [...corners, ...straddle].map(([x, yy]) => [x, yy, x + bw, yy + bh] as Rect);
      let rect = rects.slice(0, 4).find(free) ?? rects.slice(4).find((r) => free(r) && otherShare(r) < 0.05) ?? null;
      let fallback: string | null = null;
      if (!rect) { rect = rects[0]!; fallback = "corner"; log.push(`p${p.id}: narration "${t.text.slice(0, 24)}" has no free corner`); }
      return { kind: "narration", panel: p.id, textIndex: k, text: t.text, lines, rect, fallback, fontSize: size, lineHeight: lh };
    };

    const fitLines = (text: string, font: FontKind, size: number, lh: number, aspect: number, minw: number, maxw: number) => {
      const total = measure(text, font, size);
      return wrap(text, font, size, clamp(Math.sqrt(total * lh * aspect), minw, maxw));
    };

    type Spot = { r: Rect; s: number; before: boolean; tier: number };
    const tiers = [
      { own: 0.6, other: 0.06, order: true },
      { own: 0.4, other: 0.18, order: true },
      { own: 0.25, other: 0.3, order: true },
      { own: 0.12, other: 0.5, order: false },
    ];
    /** Balloon size for a text (upper case lines; a shout's burst is bigger). */
    const balloonShape = (t: TextItem, aspect: number) => {
      const whisper = t.type === "speech" && t.tone === "whisper";
      const shout = t.type === "speech" && !whisper && (t.tone === "shout" || isShout(t.text));
      const size = Math.round(TEXT.speech.size * ts), lh = Math.round(TEXT.speech.lh * ts);
      const lines = fitLines(t.text.toUpperCase(), "speech", size, lh, aspect, 90 * ts, Math.min(250 * ts, fw * 0.8));
      const tw = Math.max(...lines.map((l) => measure(l, "speech", size))), th = lines.length * lh;
      const grow = shout ? 1.22 : 1;
      return { whisper, shout, size, lh, lines, tw, th, rx: ((tw / 2) * 1.34 + 10 * ts) * grow, ry: ((th / 2) * 1.38 + 9 * ts) * grow };
    };
    /** Allowed spots of a balloon, best first (strictest tier first, then score); the last tier allows a reading-order break. */
    const balloonSpots = (t: TextItem, shape: ReturnType<typeof balloonShape>, later: number, taken: Rect[], prevBalloons: Rect[], bias: number, maxTier = tiers.length - 1): Spot[] => {
      const { rx, ry } = shape;
      const head = t.speaker && faces[t.speaker] ? heads[t.speaker] : undefined;
      const ox = rx * 2 * 0.28, oy = ry * 2 * 0.28;
      const spots: Spot[] = [];
      for (const [ti, tier] of tiers.entries()) {
        if (ti > maxTier) break;
        for (let gx = 0; gx <= 14; gx++) for (let gy = 0; gy <= 14; gy++) {
          const cx = x0 - ox + rx + ((fw + 2 * ox - 2 * rx) * gx) / 14, cy = frame[1] - oy + ry + ((y1 - frame[1] + 2 * oy - 2 * ry) * gy) / 14;
          const r: Rect = [cx - rx, cy - ry, cx + rx, cy + ry];
          if (!inPage(r)) continue;
          const a = area(r);
          const own = inter(r, cell.bbox) / a;
          if (own < tier.own) continue;
          const other = otherShare(r);
          if (other > tier.other) continue;
          const inner = shrink(r, 0.9);
          if (blocked.some((b) => inter(inner, b) > 0) || taken.some((b) => inter(inner, b) > 0)) continue;
          const before = prevBalloons.some((q) => readBefore(r, q));
          if (before && tier.order) continue;
          let sc = (bodies.reduce((sum, b) => sum + inter(r, b), 0) / a) * 3 + ((cy - frame[1]) / (y1 - frame[1])) * 1.2;
          if (head) {
            sc += (Math.hypot(cx - head[0], cy - head[1]) / Math.hypot(fw, fh)) * 2.5;
            if (cy > head[1] + ry * 0.6) sc += 1.5;
          } else sc += ((x1 - cx) / fw) * 0.8; // no speaker in frame: top right first
          // earlier balloons go high and right, leaving room to read on (stronger on the retry)
          if (later > 0) sc += (((cy - frame[1]) / (y1 - frame[1])) * 0.8 + ((x1 - cx) / fw) * 0.6) * (1 + 3 * bias);
          sc += (1 - own) * 0.8 + other * 4 + (before ? 6 : 0);
          spots.push({ r, s: sc, before, tier: ti });
        }
        if (spots.length) break;
      }
      return spots.sort((a, b) => a.s - b.s);
    };

    const placeBalloon = (t: TextItem, k: number, next: TextItem | undefined, later: number, taken: Rect[], prevBalloons: Rect[], bias: number, aspect: number): { item: BalloonItem; violates: boolean } => {
      const shape = balloonShape(t, aspect);
      const { whisper, shout, size, lh, lines, tw, th, rx, ry } = shape;
      const spots = balloonSpots(t, shape, later, taken, prevBalloons, bias);
      // look ahead: prefer a spot that still leaves the next balloon an in-order place
      const nextShape = next ? balloonShape(next, aspect) : null;
      const fits = (sp: Spot) =>
        !nextShape || balloonSpots(next!, nextShape, later - 1, [...taken, pad(sp.r, 4)], [...prevBalloons, sp.r], bias, 2).length > 0;
      let best: Spot | null = spots.slice(0, 40).find((sp) => sp.tier === spots[0]!.tier && !sp.before && fits(sp)) ?? spots[0] ?? null;
      let fallback: string | null = null;
      if (!best) {
        fallback = "corner";
        log.push(`p${p.id}: no free place for "${t.text.slice(0, 30)}", put at the top right`);
        best = { r: [x1 - 2 * rx - 6, frame[1] + 6, x1 - 6, frame[1] + 6 + 2 * ry], s: 99, before: true, tier: 4 };
      } else if (best.tier > 0) {
        fallback = `tier ${best.tier + 1}`;
        log.push(`p${p.id}: "${t.text.slice(0, 24)}" placed with relaxed tier ${best.tier + 1}`);
      }
      const r = best.r;
      const [cx, cy] = centre(r);
      const head = t.speaker && faces[t.speaker] ? heads[t.speaker] : undefined;
      let tail: Point | null = null;
      if (head && t.speaker) {
        const f = faces[t.speaker]!;
        const aim: Point = [head[0], head[1] + (f[3] - f[1]) * 0.25];
        const ddx = aim[0] - cx, ddy = aim[1] - cy, dist = Math.hypot(ddx, ddy) || 1;
        const edge = Math.hypot((rx * ddx) / dist, (ry * ddy) / dist);
        let L = Math.min(edge + 52 * ts, Math.max(edge + 14 * ts, dist - 30 * ts));
        const inFace = (q: number) => {
          const px = cx + (ddx / dist) * q, py = cy + (ddy / dist) * q;
          return px > f[0] - 4 && px < f[2] + 4 && py > f[1] - 4 && py < f[3] + 4;
        };
        while (L > edge + 6 && inFace(L)) L -= 4;
        tail = [cx + (ddx / dist) * L, cy + (ddy / dist) * L];
      }
      const item: BalloonItem = {
        kind: t.type as "speech" | "thought", panel: p.id, textIndex: k, speaker: t.speaker, text: t.text, lines, cx, cy, rx, ry, textW: tw, textH: th, tail, shout,
        rect: r, fallback, fontSize: size, lineHeight: lh, ...(whisper ? { whisper: true } : {}),
      };
      return { item, violates: best.before || fallback === "corner" };
    };

    // crowded panels: retry with the earlier balloons pushed up and right, then with narrower (taller) balloons
    let placed = placeTexts(0, 2.2);
    for (const [bias, aspect] of [[1, 2.2], [1, 1]] as const) {
      if (!placed.violations) break;
      const retry = placeTexts(bias, aspect);
      log.push(`p${p.id}: reading order retried (${placed.violations} -> ${retry.violations} out of order)`);
      if (retry.violations < placed.violations) placed = retry;
    }
    for (const item of placed.items) {
      local.push(item);
      if ("rect" in item) blocked.push(pad(item.rect, 4));
    }

    // SFX: big lettering on the background next to the action, away from faces, bodies and text
    let n = 0;
    for (const [k, t] of p.text.entries()) {
      if (t.type !== "sfx") continue;
      const size = Math.round(TEXT.sfx[cell.imp] * (p.beat === "action" ? 1.1 : 1) * ctx.sfxScale);
      const text = t.text.toUpperCase();
      const w = measure(text, "sfx", size) + 10, h = size + 10;
      let best: { r: Rect; s: number } | null = null;
      for (let gx = 0; gx <= 10; gx++) for (let gy = 0; gy <= 10; gy++) {
        const cx = x0 + w / 2 - w * 0.15 + ((fw - w * 0.7) * gx) / 10, cy = frame[1] + h / 2 - h * 0.3 + ((y1 - frame[1] - h * 0.4) * gy) / 10;
        const r: Rect = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
        if (!inPage(r)) continue;
        const a = area(r);
        if (inter(r, cell.bbox) / a < 0.65 || otherShare(r) > 0.03) continue;
        if (blocked.some((b) => inter(r, pad(b, 2)) > 0)) continue;
        const sc = bodies.reduce((sum, b) => sum + inter(r, b), 0) / a + (p.beat === "action" ? Math.abs((r[1] - frame[1]) / fh - 0.15) * 0.3 : 0);
        if (!best || sc < best.s) best = { r, s: sc };
      }
      if (!best) { log.push(`p${p.id}: sfx "${t.text}" skipped (no room)`); continue; }
      blocked.push(best.r);
      const [cx, cy] = centre(best.r);
      local.push({ kind: "sfx", panel: p.id, textIndex: k, text: t.text, cx, cy, size, rot: n++ % 2 ? 7 : -8, color: "#111", rect: best.r, breaksFrame: false } as SfxItem);
    }
    ctx.out.items.push(...local);
  });
}

/** Balloons of one panel read out of order (right to left, top to bottom), for checks. */
export function readingOrderErrors(layout: StripLayout): string[] {
  const errors: string[] = [];
  const byPanel = new Map<number, BalloonItem[]>();
  for (const item of layout.items) if (item.kind === "speech" || item.kind === "thought") byPanel.set(item.panel, [...(byPanel.get(item.panel) ?? []), item]);
  for (const [panel, list] of byPanel) list.forEach((b, i) => list.slice(0, i).forEach((a) => readBefore(b.rect, a.rect) && errors.push(`p${panel}: "${b.text}" before "${a.text}"`)));
  return errors;
}
