// Round 2 of the webtoon bench (webtoon-bench2/scripts/layout.ts), copied for Inlay Illustrator; Inlay changes are marked "Inlay:".
// Webtoon strip layout (pure module: no IO, no globals besides constants).
// Input: validated storyboard + per-panel image size, optional face boxes and character cut-out.
// Output: layout JSON in a 690 px design space (panels, balloons, narration boxes, SFX, title). Render it with render-html.ts.
import { FONT_METRICS } from "./font-metrics.js";
import type { ImagePanel, Storyboard, TextBeatPanel, TextItem, StoryCharacter } from "./storyboard-schema.js";

export type FontKind = "speech" | "narration" | "sfx";
export interface NBox { left: number; top: number; right: number; bottom: number } // normalized image coords 0..1
export interface PanelImage {
  width: number;
  height: number;
  faces?: Record<string, NBox>; // detected face boxes by character name (optional, e.g. a vision check)
  cutout?: { src: string; bbox: NBox; mask?: string[] }; // RGBA cut-out of the characters (optional): enables a character frame-break on action beats
  // Inlay: `mask` = the cut-out's character area, rows of "0"/"1" cells over the image; balloons keep off it, SFX prefer the rest
}
export interface LayoutOptions {
  /** Inlay: strip width (default 690). Panel geometry and SFX scale with it; balloon and narration text keep their size. */
  width?: number;
  measure?: (text: string, font: FontKind, sizePx: number) => number; // text advance width in px; default: built-in font metrics
}
// Inlay: the output types live in the shared contract (the chat view renders them).
import { STRIP_SPEECH_PX, STRIP_WIDTH, type LaidItem, type PanelLayout, type Rect, type StripLayout } from "../../shared/contract/webtoon.js";
export type { LaidItem, PanelLayout, Rect, StripLayout };

// ---------- constants (same rules for every strip) ----------
export const RULES = {
  // Inlay: the geometry values below are for the 690 px width; `layoutStrip` scales them to `opts.width`.
  insetW: 500,
  maxPanelH: 1100,
  maxTitleH: 1050,
  maxInsetH: 900,
  maxBandH: 360,
  tightH: 400,
  gap: { base: 36, action: 22, reaction: 64, scene: 150, pause: 120 },
  speech: { size: STRIP_SPEECH_PX, lh: 22 },
  narration: { size: 20, lh: 24 },
  sfx: { action: 88, normal: 64, beat: 72, letterSpacing: 2 },
  sfxColors: ["#ff4f7f", "#ffc21a", "#38c6ff", "#ff7a2e"],
  onArtMin: 0.45, // share of a balloon that must sit on the art (or the free column beside an inset)
  tailMax: 48,
  breakDepth: [60, 140] as [number, number],
  charMax: 0.08, // Inlay: largest share of a balloon on the cut-out's character area
  breakMaxTop: 0.45, // top break only when the cut-out starts in the top 45% (the frame then starts just below the head; the scene above is not shown) // frame line this far below the cut-out top (px, clamped from 10% of the panel height)
};
// framing -> (max half-height of the body box around the NovelAI center, face height), fractions of image height.
// Calibrated once on bench strip (a)'s Jev boxes: NovelAI centres the body box on the pin, cut by the frame edge.
const HEAD: Record<string, [number, number]> = { portrait: [0.5, 0.38], "upper body": [0.35, 0.18], "cowboy shot": [0.32, 0.14], "full body": [0.32, 0.1] };

// ---------- helpers ----------
const inter = (a: Rect, b: Rect) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
const area = (a: Rect) => Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
const pad = (r: Rect, p: number): Rect => [r[0] - p, r[1] - p, r[2] + p, r[3] + p];
const shift = (r: Rect, dy: number): Rect => [r[0], r[1] + dy, r[2], r[3] + dy];
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function defaultMeasure(text: string, font: FontKind, size: number): number {
  const m = FONT_METRICS[font];
  let w = 0;
  for (const ch of text) w += m[ch] ?? m["n"] ?? 500;
  return (w * size) / 1000 + (font === "sfx" ? RULES.sfx.letterSpacing * text.length : 0);
}

export function isShout(t: string): boolean {
  const letters = [...t].filter((c) => /[a-z]/i.test(c));
  const caps = letters.filter((c) => c === c.toUpperCase()).length / Math.max(1, letters.length);
  return t.includes("?!") || t.includes("!!") || (t.trimEnd().endsWith("!") && caps > 0.5);
}

/** Head point and face box of a character in normalized image coords: the detected face box, else estimated from the NovelAI centre and framing (no face for hands only / lower body). */
export function charGeometry(c: StoryCharacter, iw: number, ih: number, faces?: Record<string, NBox>): { head: [number, number]; face: Rect | null } {
  const f = faces?.[c.name];
  if (f) return { head: [(f.left + f.right) / 2, (f.top + f.bottom) / 2], face: [f.left, f.top, f.right, f.bottom] };
  const hd = HEAD[c.framing];
  if (!hd) return { head: [c.x, Math.max(0.05, c.y - 0.25)], face: null };
  let [half, fh] = hd;
  if (c.framing !== "portrait") half = Math.min(half, c.y, 1 - c.y);
  const hy = Math.max(fh / 2 + 0.01, c.y - half + 0.6 * fh);
  const fw = ((fh * ih) / iw) * 1.3;
  return { head: [c.x, hy], face: [c.x - fw / 2, hy - fh / 2, c.x + fw / 2, hy + fh / 2] };
}

export function layoutStrip(sb: Storyboard, images: Record<string, PanelImage>, opts: LayoutOptions = {}): StripLayout {
  const W = opts.width ?? STRIP_WIDTH;
  const k = W / STRIP_WIDTH;
  const measure = opts.measure ?? defaultMeasure;
  const log: string[] = [];
  const panelsOut: PanelLayout[] = [];
  const items: LaidItem[] = [];
  let sfxI = 0;

  const wrap = (text: string, font: FontKind, size: number, maxw: number) => {
    const lines: string[] = []; let cur = "";
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const t = (cur + " " + w).trim();
      if (measure(t, font, size) <= maxw || !cur) cur = t; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const fitText = (text: string, font: FontKind, size: number, lh: number, aspect: number, minw: number, maxw: number) => {
    const total = measure(text, font, size);
    const tw = clamp(Math.sqrt(total * lh * aspect), minw, maxw);
    const lines = wrap(text, font, size, tw);
    return { lines, w: Math.max(...lines.map((l) => measure(l, font, size))), h: lines.length * lh };
  };

  // ---------- panel shape ----------
  function shape(p: ImagePanel, iw: number, ih: number) {
    const lay = p.layout;
    let x = 0, w = W;
    if (lay === "inset_left" || lay === "inset_right") { w = Math.round(RULES.insetW * k); x = lay === "inset_left" ? 0 : W - w; }
    let h = Math.round((w * ih) / iw);
    if (lay === "tight_crop") h = Math.min(h, RULES.tightH * k);
    else if (lay === "wide_band") h = Math.min(h, RULES.maxBandH * k);
    h = Math.round(Math.min(h, (lay === "title" ? RULES.maxTitleH : lay.startsWith("inset") ? RULES.maxInsetH : RULES.maxPanelH) * k));
    const vis = (w / iw) * ih;
    return { x, w, h, frac: h < vis - 1 ? h / vis : 1 };
  }

  // ---------- grid search ----------
  type Region = [number, number, number, number];
  function search(regions: Region[], score: (cx: number, cy: number) => number | null, step = 14) {
    let best: [number, number, number] | null = null;
    for (let [xa, xb, ya, yb] of regions) {
      [xa, xb] = [Math.min(xa, xb), Math.max(xa, xb)]; [ya, yb] = [Math.min(ya, yb), Math.max(ya, yb)];
      const nx = Math.max(1, Math.floor((xb - xa) / step) + 1), ny = Math.max(1, Math.floor((yb - ya) / step) + 1);
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const cx = xa + (xb - xa) * (i / Math.max(1, nx - 1)), cy = ya + (yb - ya) * (j / Math.max(1, ny - 1));
        const s = score(cx, cy);
        if (s !== null && (!best || s < best[0])) best = [s, cx, cy];
      }
    }
    return best;
  }

  // ---------- image panel ----------
  let y = 0;
  let prevKind: string | null = null;

  const gapBefore = (p: ImagePanel | TextBeatPanel) => {
    if (prevKind === null) return 0;
    if (p.kind === "text_beat" || prevKind === "text_beat") return RULES.gap.pause;
    if (p.scene_change) return RULES.gap.scene;
    if (p.beat === "reaction" || p.beat === "quiet") return RULES.gap.reaction;
    if (p.beat === "action") return RULES.gap.action;
    return RULES.gap.base;
  };

  function imagePanel(p: ImagePanel, first: boolean) {
    const img = images[String(p.id)];
    if (!img) { log.push(`p${p.id}: no image, skipped`); return; }
    const { width: iw, height: ih } = img;
    const { x: x0, w, h, frac } = shape(p, iw, ih);
    const chars = p.nai.characters;
    const geo = new Map(chars.map((c) => [c.name, charGeometry(c, iw, ih, img.faces)]));
    const speakers = p.text.filter((t) => t.type === "speech" || t.type === "thought").map((t) => t.speaker);
    let focusYs = speakers.filter((n): n is string => !!n && geo.has(n)).map((n) => geo.get(n)!.head[1]);
    if (!focusYs.length) focusYs = [...geo.values()].map((g) => g.head[1]);
    if (!focusYs.length) focusYs = [0.5];
    if (p.layout === "title") focusYs = [0.62];
    let crop: [number, number, number, number] = [0, 0, 1, 1];
    if (frac < 1) { const fy = focusYs.reduce((a, b) => a + b, 0) / focusYs.length; const top = clamp(fy - frac / 2, 0, 1 - frac); crop = [0, top, 1, top + frac]; }
    const toPx = (nx: number, ny: number): [number, number] => [x0 + nx * w, ((ny - crop[1]) / (crop[3] - crop[1])) * h];
    const facePx = new Map<string, { head: [number, number]; face: Rect | null }>();
    for (const [n, g] of geo) {
      const fb = g.face ? ([...toPx(g.face[0], g.face[1]), ...toPx(g.face[2], g.face[3])] as Rect) : null;
      facePx.set(n, { head: toPx(...g.head), face: fb });
    }
    const faces = [...facePx.values()].map((v) => v.face).filter((f): f is Rect => !!f);
    // Inlay: share of a rect on the cut-out's character cells (7 x 7 sample points)
    const mask = img.cutout?.mask;
    const onChar = (r: Rect) => {
      if (!mask?.length) return 0;
      let hit = 0;
      for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
        const nx = (r[0] + ((r[2] - r[0]) * (i + 0.5)) / 7 - x0) / w, ny = crop[1] + ((r[1] + ((r[3] - r[1]) * (j + 0.5)) / 7) / h) * (crop[3] - crop[1]);
        if (nx < 0 || nx >= 1 || ny < 0 || ny >= 1) continue;
        const row = mask[Math.floor(ny * mask.length)]!;
        if (row[Math.floor(nx * row.length)] === "1") hit++;
      }
      return hit / 49;
    };
    // rough body boxes below each head (soft obstacle for SFX)
    const bodies: Rect[] = chars.filter((c) => c.framing !== "hands only").map((c) => {
      const g = facePx.get(c.name)!; const fwid = g.face ? g.face[2] - g.face[0] : 0.25 * w;
      return [g.head[0] - fwid, g.head[1], g.head[0] + fwid, toPx(c.x, Math.min(1, c.y + (c.y - geo.get(c.name)!.head[1])))[1]] as Rect;
    });

    // frame-break: an action beat with a character cut-out pops the character over the top (or a side) of the frame
    let frame: Rect = [x0, 0, x0 + w, h];
    let frameBreak: PanelLayout["frameBreak"] = null;
    let cutTop = 0;
    if (p.beat === "action" && img.cutout && chars.length === 1) { // one actor: the cut-out is that character
      const bb = img.cutout.bbox;
      const [bl, bt] = toPx(bb.left, bb.top); const [br] = toPx(bb.right, bb.bottom);
      const depth = clamp(0.1 * h, RULES.breakDepth[0] * k, RULES.breakDepth[1] * k);
      const sideDepth = Math.min(depth, 0.12 * w);
      if (bt > 0.03 * h && bt <= RULES.breakMaxTop * h) { frame = [x0, bt + depth, x0 + w, h]; frameBreak = "top"; cutTop = bt; }
      // side breaks only toward an inset's free column, so the panel loses little width
      else if (p.layout === "inset_right" && bl - x0 > 0.03 * w && bl - x0 <= 0.15 * w) { frame = [bl + sideDepth, 0, x0 + w, h]; frameBreak = "left"; }
      else if (p.layout === "inset_left" && x0 + w - br > 0.03 * w && x0 + w - br <= 0.15 * w) { frame = [x0, 0, br - sideDepth, h]; frameBreak = "right"; }
      log.push(`p${p.id}: frame-break ${frameBreak ?? "none (character not near a frame edge)"}`);
    }
    const [fx0, ft, fx1, fb] = frame;
    const fw = fx1 - fx0;
    // the white column beside an inset counts as space for text
    const col: Rect | null = p.layout === "inset_left" ? [x0 + w, ft, W, fb] : p.layout === "inset_right" ? [0, ft, x0, fb] : null;
    const onArt = (r: Rect) => (inter(r, frame) + (col ? inter(r, col) : 0)) / Math.max(1, area(r));

    const placed: Rect[] = [];
    const local: LaidItem[] = [];
    let prevCy = -1e9;
    const nBalloons = p.text.filter((t) => t.type === "speech" || t.type === "thought").length;
    let sfxInPanel = 0;

    const anchorRegion = (anchor: string, rx: number, ry: number): Region[] => {
      const L = 6 + rx, R = W - 6 - rx, mid = fx0 + fw / 2, fh = fb - ft;
      const xs = { left: [L, mid], right: [mid, R], both: [L, R] } as const;
      const ys = { top: [ft + ry * 0.2, ft + fh * 0.38], mid: [ft + fh * 0.3, ft + fh * 0.7], bot: [ft + fh * 0.62, fb + ry * 0.35] } as const;
      const A: Record<string, Region> = {
        "top-left": [...xs.left, ...ys.top], "top-right": [...xs.right, ...ys.top], top: [...xs.both, ...ys.top],
        left: [...xs.left, ...ys.mid], right: [...xs.right, ...ys.mid], "bottom-left": [...xs.left, ...ys.bot], "bottom-right": [...xs.right, ...ys.bot],
        "over-top-edge": [...xs.both, ft - ry * 0.15, ft + ry * 0.15], "over-bottom-edge": [...xs.both, fb - ry * 0.15, fb + ry * 0.15],
      };
      return [A[anchor] ?? A.top];
    };

    const placeBalloon = (t: TextItem): LaidItem | null => {
      const shout = t.type === "speech" && isShout(t.text);
      const { lines, w: tw, h: th } = fitText(t.text, "speech", RULES.speech.size, RULES.speech.lh, 3.4, 96, 270);
      const k = shout ? 1.25 : 1;
      const rx = (tw / 2) * 1.32 * k + 12, ry = (th / 2) * 1.38 * k + 10;
      let sp = t.speaker ? facePx.get(t.speaker) : undefined;
      if (sp && !sp.face) sp = undefined;
      const target = sp?.head ?? null;
      const score = (minArt: number) => (cx: number, cy: number) => {
        const r: Rect = [cx - rx * 0.92, cy - ry * 0.92, cx + rx * 0.92, cy + ry * 0.92];
        if (r[0] < 4 || r[2] > W - 4) return null;
        if (faces.some((f) => inter(r, pad(f, 6)) > 0)) return null;
        if (placed.some((q) => inter(r, pad(q, 8)) > 0)) return null;
        if (cy < prevCy + 30) return null;
        if (onArt(r) < minArt) return null;
        if (onChar(r) > RULES.charMax) return null;
        let s = 0;
        if (target) {
          const d = Math.hypot(cx - target[0], cy - target[1]) - Math.max(rx, ry);
          s += Math.max(0, 30 - d, d - 160) * 1.5;
          s += cy * (nBalloons > 1 ? 0.4 : 0.1);
          if (cy > target[1] + 40) s += 400;
        } else s += Math.abs(cy - (ft + (fb - ft) * 0.15)) * 0.3;
        s += (1 - onArt(r)) * 120; // prefer fully on the art
        return s;
      };
      let fallback: string | null = null;
      let best = search(anchorRegion(t.anchor, rx, ry), score(RULES.onArtMin));
      if (!best && target) {
        fallback = "side";
        const side: [number, number] = t.anchor.includes("left") ? [6 + rx, fx0 + fw / 2] : t.anchor.includes("right") ? [fx0 + fw / 2, W - 6 - rx] : [6 + rx, W - 6 - rx];
        best = search([[...side, ft + ry * 0.2, target[1] + 20]], score(RULES.onArtMin));
      }
      if (!best) { fallback = "anywhere"; best = search([[6 + rx, W - 6 - rx, ft - ry, fb + ry]], score(0.2)); }
      if (!best) { fallback = "gutter"; best = [0, W / 2, prevCy > -1e8 ? prevCy + 2 * ry + 20 : ft - ry - 14]; }
      const [, cx, cy] = best;
      let tail: [number, number] | null = null;
      if (target && sp) {
        const fbx = sp.face!;
        const aim: [number, number] = [target[0], target[1] + (fbx[3] - fbx[1]) * 0.18];
        const dx = aim[0] - cx, dy = aim[1] - cy, dist = Math.hypot(dx, dy) || 1;
        const edge = Math.hypot((rx * dx) / dist, (ry * dy) / dist);
        let L = dist - 14;
        while (L > edge && fbx[0] - 4 < cx + (dx / dist) * L && cx + (dx / dist) * L < fbx[2] + 4 && fbx[1] - 4 < cy + (dy / dist) * L && cy + (dy / dist) * L < fbx[3] + 4) L -= 4;
        L = Math.min(edge + RULES.tailMax, Math.max(edge + 14, L));
        tail = [cx + (dx / dist) * L, cy + (dy / dist) * L];
      } else if (t.speaker) {
        tail = [cx + (rx + 24) * (cx < W / 2 ? -1 : 1) * 0.6, cy < (ft + fb) / 2 ? cy - ry - 20 : cy + ry + 20];
      }
      return { kind: t.type as "speech" | "thought", panel: p.id, textIndex: p.text.indexOf(t), speaker: t.speaker, text: t.text, lines, cx, cy, rx, ry, textW: tw, textH: th, tail, shout,
               rect: [cx - rx, cy - ry, cx + rx, cy + ry], fallback };
    };

    const placeNarr = (t: TextItem): LaidItem => {
      const { lines, w: tw, h: th } = fitText(t.text, "narration", RULES.narration.size, RULES.narration.lh, 3.4, 60, 300);
      const bw = tw + 36, bh = th + 24;
      const a = t.anchor;
      const wantTop = !(a.startsWith("bottom") || a === "over-bottom-edge");
      const wantLeft = !a.includes("right");
      // corner candidates: flush in the frame corner, straddling the frame edge at the corner, hanging into the inset's free column
      const corner = (top: boolean, left: boolean): [number, number][] => {
        const xIn = left ? fx0 : fx1 - bw;
        const yIn = top ? ft : fb - bh;
        const out: [number, number][] = [[xIn, yIn], [left ? fx0 + 14 : fx1 - bw - 14, top ? ft - bh / 2 : fb - bh / 2]];
        if (col && ((left && p.layout === "inset_right") || (!left && p.layout === "inset_left"))) out.push([left ? fx0 - bw * 0.5 : fx1 - bw * 0.5, yIn]);
        return out;
      };
      const cands = [...corner(wantTop, wantLeft), ...corner(wantTop, !wantLeft), ...corner(!wantTop, wantLeft), ...corner(!wantTop, !wantLeft)];
      for (const [x, y0] of cands) {
        const r: Rect = [x, y0, x + bw, y0 + bh];
        if (r[0] < 0 || r[2] > W) continue;
        if (faces.some((f) => inter(r, pad(f, 6)) > 0) || placed.some((q) => inter(r, pad(q, 8)) > 0)) continue;
        return { kind: "narration", panel: p.id, textIndex: p.text.indexOf(t), text: t.text, lines, rect: r, fallback: null };
      }
      const y0 = Math.max(fb + 16, ...placed.filter((q) => q[1] >= fb).map((q) => q[3] + 8)); // Inlay: stack gutter boxes
      return { kind: "narration", panel: p.id, textIndex: p.text.indexOf(t), text: t.text, lines, rect: [fx0 + 14, y0, fx0 + 14 + bw, y0 + bh], fallback: "gutter" };
    };

    const placeSfx = (t: TextItem): LaidItem => {
      const action = p.beat === "action";
      const size = Math.round((action ? RULES.sfx.action : RULES.sfx.normal) * k);
      const tw = measure(t.text.toUpperCase(), "sfx", size);
      const bw = tw + 10, bh = size + 10;
      const breakEdge = action && sfxInPanel === 0;
      const score = (cx: number, cy: number) => {
        const r: Rect = [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2];
        if (r[0] < 4 || r[2] > W - 4) return null;
        if (faces.some((f) => inter(r, pad(f, 0.3 * (f[2] - f[0]))) > 0) || placed.some((q) => inter(r, pad(q, 6)) > 0)) return null;
        return (bodies.reduce((s, b) => s + inter(r, b), 0) / area(r)) * 100 + onChar(r) * 100; // prefer the background next to the action over the bodies
      };
      const a = t.anchor;
      const left = a.includes("left"), right = a.includes("right");
      const xr: [number, number] = [left ? fx0 + bw / 2 + 6 : fx0 + fw / 2, right ? fx1 - bw / 2 - 6 : fx0 + fw / 2];
      if (!left && !right) { xr[0] = fx0 + bw / 2 + 6; xr[1] = fx1 - bw / 2 - 6; }
      let best: [number, number, number] | null = null;
      let breaks = false;
      if (breakEdge) {
        // straddle the frame: bottom or top edge (on the anchor's side), or the inner side edge of an inset
        const edges: Region[] = [];
        const bottomFirst = a.startsWith("bottom") || a === "over-bottom-edge" || a === "left" || a === "right";
        const top: Region = [xr[0], xr[1], ft, ft], bottom: Region = [xr[0], xr[1], fb, fb];
        edges.push(...(bottomFirst ? [bottom, top] : [top, bottom]));
        if (p.layout === "inset_left") edges.push([fx1, fx1, ft + bh, fb - bh]);
        if (p.layout === "inset_right") edges.push([fx0, fx0, ft + bh, fb - bh]);
        best = search(edges, score, 20);
        breaks = !!best;
      }
      if (!best) {
        const regs = anchorRegion(a.startsWith("over") ? "left" : a, bw / 2, bh / 2).map(([xa, xb, ya, yb]) =>
          [Math.max(xa, fx0 + bw / 2 + 6), Math.min(xb, fx1 - bw / 2 - 6), Math.max(ya, ft + bh / 2 + 6), Math.min(yb, fb - bh / 2 - 6)] as Region);
        best = search(regs, score, 20) ?? search([[fx0 + bw / 2 + 6, fx1 - bw / 2 - 6, ft + bh / 2 + 6, fb - bh / 2 - 6]], score, 20);
      }
      const [cx, cy] = best ? [best[1], best[2]] : [fx0 + fw / 2, fb - bh];
      const rot = breaks ? (cx < W / 2 ? -14 : 12) : cx < W / 2 ? -10 : 8;
      sfxInPanel++;
      return { kind: "sfx", panel: p.id, textIndex: p.text.indexOf(t), text: t.text, cx, cy, size, rot, color: RULES.sfxColors[sfxI++ % RULES.sfxColors.length],
               rect: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], breaksFrame: breaks };
    };

    const texts = p.layout === "title" ? p.text.filter((t) => t.type !== "speech") : p.text;
    for (const t of texts) {
      let r: LaidItem | null = null;
      if (t.type === "speech" || t.type === "thought") { r = placeBalloon(t); if (r) prevCy = (r as any).cy; }
      else if (t.type === "narration") r = placeNarr(t);
      else if (t.type === "sfx") r = placeSfx(t);
      if (r && "rect" in r) { placed.push(r.rect); local.push(r); }
    }
    let top = Math.min(frameBreak === "top" ? cutTop : ft, ...local.map((r) => ("rect" in r ? r.rect[1] - 8 : 0)));
    const bottom = Math.max(h, ...local.map((r) => ("rect" in r ? r.rect[3] + 8 : 0)));
    if (first && p.layout === "title") top = 0;
    const oy = y - top;
    const fade: PanelLayout["fade"] = p.layout === "fade_white" || p.layout === "title" ? "bottom" : p.layout === "wide_band" && p.beat === "insert" ? "sides" : null;
    const heads: Record<string, [number, number]> = {}, facesOut: Record<string, Rect | null> = {};
    for (const [n, v] of facePx) { heads[n] = [v.head[0], v.head[1] + oy]; facesOut[n] = v.face ? shift(v.face, oy) : null; }
    panelsOut.push({ id: p.id, rect: [x0, oy, x0 + w, oy + h], crop, frame: shift(frame, oy), frameBreak, cutout: frameBreak && img.cutout ? { src: img.cutout.src } : null,
                     fade, heads, faces: facesOut });
    if (p.layout === "title") {
      const [a, ...rest] = sb.title.split(":");
      const b = rest.join(":").trim();
      items.push({ kind: "title", panel: p.id, small: b ? a.trim().toUpperCase() : "", big: b || a.trim(), y: oy + h * 0.13 });
    }
    for (const r of local) {
      if (r.kind === "speech" || r.kind === "thought") items.push({ ...r, cy: r.cy + oy, rect: shift(r.rect, oy), tail: r.tail ? [r.tail[0], r.tail[1] + oy] : null });
      else if (r.kind === "narration") items.push({ ...r, rect: shift(r.rect, oy) });
      else if (r.kind === "sfx") items.push({ ...r, cy: r.cy + oy, rect: shift(r.rect, oy) });
    }
    y = oy + bottom;
  }

  function textBeat(p: TextBeatPanel) {
    let side = 0;
    for (const t of p.text) {
      if (t.type === "sfx") {
        const size = Math.round(RULES.sfx.beat * k), tw = measure(t.text.toUpperCase(), "sfx", size);
        items.push({ kind: "sfx", panel: p.id, textIndex: p.text.indexOf(t), text: t.text, cx: W / 2, cy: y + size / 2, size, rot: -8, color: RULES.sfxColors[sfxI++ % RULES.sfxColors.length],
                     rect: [W / 2 - tw / 2, y, W / 2 + tw / 2, y + size], breaksFrame: false });
        y += size + 30; continue;
      }
      if (t.type === "thought" || t.type === "speech") {
        const { lines, w: tw, h: th } = fitText(t.text, "speech", RULES.speech.size, RULES.speech.lh, 3.4, 96, 270);
        const rx = (tw / 2) * 1.32 + 12, ry = (th / 2) * 1.38 + 10, cx = side === 0 ? 70 + rx : W - 70 - rx, cy = y + ry;
        items.push({ kind: t.type, panel: p.id, textIndex: p.text.indexOf(t), speaker: t.speaker, text: t.text, lines, cx, cy, rx, ry, textW: tw, textH: th, tail: null, shout: false,
                     rect: [cx - rx, cy - ry, cx + rx, cy + ry], fallback: null });
        y += 2 * ry + 30; side ^= 1; continue;
      }
      const { lines, w: tw, h: th } = fitText(t.text, "narration", RULES.narration.size, RULES.narration.lh, 3.2, 60, 330);
      const bw = tw + 40, bh = th + 28, x = side === 0 ? 70 : W - 70 - bw;
      items.push({ kind: "narration", panel: p.id, textIndex: p.text.indexOf(t), text: t.text, lines, rect: [x, y, x + bw, y + bh], fallback: null });
      y += bh + 40; side ^= 1;
    }
    y -= 40;
  }

  sb.panels.forEach((p, i) => {
    y += gapBefore(p);
    if (p.kind === "image") imagePanel(p, i === 0); else textBeat(p);
    prevKind = p.kind;
  });
  y += 100;
  return { width: W, height: Math.round(y), panels: panelsOut, items, log };
}
