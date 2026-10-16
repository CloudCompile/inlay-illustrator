// Round 2 of the webtoon bench (webtoon-bench2/scripts/storyboard-validate.ts), copied for Inlay Illustrator; Inlay changes are marked "Inlay:".
// Code validation + repair of the planner output (pure module: no IO). Every change is logged.
import {
  ANCHORS, FRAMINGS, GRID, IMAGE_SIZES, LAYOUTS, PORTRAIT_SIZES,
  type Anchor, type ImagePanel, type Panel, type PlannerCharacter, type Storyboard, type TextBeatPanel, type TextItem,
} from "./storyboard-schema.js";

export const LIMITS = { minImages: 6, maxImages: 8, maxBalloons: 2, maxNarrImage: 2, maxNarrBeat: 3, maxWords: 12, repairRatio: 0.85, portraitShare: 0.6 };

// ---------- quote check ----------
export function normWords(s: string): string[] {
  s = s.replace(/[\u2019\u2018]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2014\u2013]/g, " ").replace(/\u2026/g, " ... ").replace(/[*_]/g, "");
  return (s.toLowerCase().match(/[a-z0-9']+/g) ?? []).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
}

function fragments(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\.\.\.|\u2026|\u2014|--/).map((f) => f.trim()).filter((f) => normWords(f).length);
}

/** Quoted speech of one paragraph joined into one stream, so a line split by a speech tag ("No," she said. "I was...") matches when joined. */
function speechStream(para: string): string {
  const segs: string[] = [];
  for (const m of para.matchAll(/["\u201c]([^"\u201d]*)["\u201d]|\*([^*]+)\*/g)) segs.push((m[1] ?? m[2] ?? "").trim());
  return segs.join(" ");
}

interface QuoteIndex { hay: string[]; texts: string[] }

export function buildQuoteIndex(source: string): QuoteIndex {
  const paras = source.split("\n").filter((p) => p.trim());
  const streams = paras.map(speechStream).filter((s) => s.trim());
  const texts = [...paras, ...streams];
  return { texts, hay: [" " + normWords(source).join(" ") + " ", ...streams.map((s) => " " + normWords(s).join(" ") + " ")] };
}

function lcs(a: string[], b: string[]): number {
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function repairFragment(frag: string, idx: QuoteIndex): [number, string | null] {
  const tw = normWords(frag); const n = tw.length; let best: [number, string | null] = [0, null];
  for (const text of idx.texts) {
    const toks = [...text.matchAll(/[A-Za-z0-9'\u2019]+/g)]
      .map((m) => ({ w: m[0].replace(/^['\u2019]+|['\u2019]+$/g, "").toLowerCase().replace(/\u2019/g, "'"), a: m.index!, b: m.index! + m[0].length }))
      .filter((t) => t.w);
    for (const L of new Set([Math.max(1, n - 1), n, n + 1])) {
      for (let i = 0; i + L <= toks.length; i++) {
        const win = toks.slice(i, i + L);
        const r = (2 * lcs(tw, win.map((t) => t.w))) / (n + L);
        if (r > best[0]) best = [r, text.slice(win[0].a, win[L - 1].b)];
      }
    }
  }
  return best;
}

export interface QuoteNote { kind: "repaired" | "dropped" | "joined"; fragment: string; replacement: string | null; ratio: number }

export function checkQuote(text: string, idx: QuoteIndex): { text: string | null; notes: QuoteNote[] } {
  const keep: string[] = []; const notes: QuoteNote[] = [];
  for (const f of fragments(text)) {
    const w = " " + normWords(f).join(" ") + " ";
    const hit = idx.hay.findIndex((h) => h.includes(w));
    if (hit === 0) { keep.push(f); continue; }
    if (hit > 0) { keep.push(f); notes.push({ kind: "joined", fragment: f, replacement: null, ratio: 1 }); continue; }
    const [r, cand] = repairFragment(f, idx);
    if (r >= LIMITS.repairRatio && cand) {
      const end = /[!?.]$/.test(f.trimEnd()) ? f.trimEnd().slice(-1) : "";
      keep.push(cand + end); notes.push({ kind: "repaired", fragment: f, replacement: cand + end, ratio: r });
    } else notes.push({ kind: "dropped", fragment: f, replacement: null, ratio: r });
  }
  // keep the "..." the planner used between kept fragments
  return { text: keep.length ? keep.join(text.includes("...") || text.includes("\u2026") ? "... " : " ").replace(/([.!?])\.\.\. /g, "$1 ") : null, notes };
}

function splitLong(t: string): string[] {
  const words = t.split(/\s+/);
  if (words.length <= LIMITS.maxWords) return [t];
  const parts = t.split(/(?<=[.!?])\s+/);
  if (parts.length < 2) return [t];
  const a: string[] = [], b: string[] = []; let acc = 0;
  for (const p of parts) { (acc + p.split(/\s+/).length <= Math.ceil(words.length / 2) || !a.length ? a : b).push(p); acc += p.split(/\s+/).length; }
  return b.length ? [a.join(" "), b.join(" ")] : [t];
}

const snap = (v: unknown) => { const n = Number(v); const x = Number.isFinite(n) ? n : 0.5; return GRID.reduce((a, g) => (Math.abs(g - x) < Math.abs(a - x) ? g : a), GRID[0]); };

export function hardOk(raw: any): boolean {
  try {
    const imgs = raw.panels.filter((p: any) => p?.kind === "image");
    return imgs.length >= LIMITS.minImages && imgs.length <= LIMITS.maxImages && imgs.every((p: any) => p.nai?.base);
  } catch { return false; }
}

function outfitItems(r: PlannerCharacter): string[] {
  return Object.values(r.outfit).flatMap((v) => (v ?? "").split(",").map((t) => t.trim()).filter(Boolean));
}

export function validateStoryboard(raw: any, roster: PlannerCharacter[], source: string) {
  const log: string[] = [];
  const stats: Record<string, any> = { invented_dropped: 0, quote_repaired: 0, quote_joined: 0, balloons_dropped: 0, split: 0, layout_repaired: 0,
    size_repaired: 0, narration_merged: 0, sfx_missing_action: 0, unknown_char: 0, outfit_dropped: [] as string[] };
  const byName = new Map(roster.map((r) => [r.name, r]));
  const idx = buildQuoteIndex(source);
  const sb: Storyboard = { title: String(raw.title ?? ""), key_props: raw.key_props ?? [], panels: [] };
  const panels: Panel[] = (raw.panels ?? []).filter((p: any) => p && typeof p === "object");

  // ---- text items ----
  for (const p of panels) {
    const out: TextItem[] = [];
    for (const t0 of (p as any).text ?? []) {
      if (!t0 || !String(t0.text ?? "").trim()) continue;
      const t: TextItem = { type: t0.type, speaker: t0.speaker ?? null, text: String(t0.text).trim(), anchor: t0.anchor };
      if (!["speech", "thought", "narration", "sfx"].includes(t.type)) continue;
      const a = String(t.anchor);
      t.anchor = (a === "gutter-above" ? "over-top-edge" : a === "gutter-below" ? "over-bottom-edge" : ANCHORS.includes(a as Anchor) ? a : t.type === "narration" ? "top-left" : "top") as Anchor;
      if (t.type === "speech" || t.type === "thought") {
        const q = checkQuote(t.text, idx);
        for (const nt of q.notes) {
          if (nt.kind === "repaired") { stats.quote_repaired++; log.push(`p${p.id}: quote repaired (${nt.ratio.toFixed(2)}) "${nt.fragment}" -> "${nt.replacement}"`); }
          else if (nt.kind === "joined") { stats.quote_joined++; log.push(`p${p.id}: quote kept, joined across narration "${nt.fragment}"`); }
          else { stats.invented_dropped++; log.push(`p${p.id}: dropped invented sentence (${nt.ratio.toFixed(2)}) "${nt.fragment}"`); }
        }
        if (!q.text) continue;
        t.text = q.text;
        const parts = splitLong(t.text);
        if (parts.length > 1) { stats.split++; log.push(`p${p.id}: split ${t.text.split(/\s+/).length}-word balloon`); out.push({ ...t, text: parts[0] }, { ...t, text: parts[1] }); continue; }
      }
      out.push(t);
    }
    (p as any).text = out;
  }

  // ---- text beats: keep one deliberate pause, merge the others into the neighbouring image panel ----
  let pauseKept = false;
  const narrCount = (p: Panel) => p.text.filter((t) => t.type === "narration").length;
  const kept: Panel[] = [];
  panels.forEach((p, i) => {
    if (p.kind !== "text_beat") { kept.push(p); return; }
    if ((p as TextBeatPanel).pause && !pauseKept) { pauseKept = true; p.layout = "text_on_white"; kept.push(p); return; }
    const next = panels.slice(i + 1).find((q) => q.kind === "image");
    const prev = [...kept].reverse().find((q) => q.kind === "image");
    const items = p.text;
    const room = (q?: Panel) => q && narrCount(q) + items.filter((t) => t.type === "narration").length <= LIMITS.maxNarrImage;
    if (room(next)) {
      next!.text = [...items.map((t, k) => ({ ...t, anchor: (t.type === "narration" ? (k % 2 ? "top-right" : "top-left") : t.anchor) as Anchor })), ...next!.text];
      if (p.scene_change) next!.scene_change = true;
      stats.narration_merged += items.length; log.push(`p${p.id}: text beat merged into the top of p${next!.id}`);
    } else if (room(prev)) {
      prev!.text = [...prev!.text, ...items.map((t, k) => ({ ...t, anchor: (t.type === "narration" ? (k % 2 ? "bottom-left" : "bottom-right") : t.anchor) as Anchor }))];
      stats.narration_merged += items.length; log.push(`p${p.id}: text beat merged into the bottom of p${prev!.id}`);
    } else if (!pauseKept) {
      pauseKept = true; (p as TextBeatPanel).pause = true; kept.push(p); log.push(`p${p.id}: text beat kept as the pause (no room to merge)`);
    } else { stats.balloons_dropped += items.length; log.push(`p${p.id}: text beat dropped (no room)`); }
  });

  // ---- image panels ----
  const imgs = kept.filter((p): p is ImagePanel => p.kind === "image");
  imgs.forEach((p, i) => {
    const nai = (p.nai ??= { base: "", characters: [] });
    if (!IMAGE_SIZES.includes(p.size)) { p.size = "832x1216"; log.push(`p${p.id}: bad size -> 832x1216`); }
    const chars = [];
    for (const c of nai.characters ?? []) {
      const r = byName.get(c.name);
      if (!r) { stats.unknown_char++; log.push(`p${p.id}: dropped unknown character ${c.name}`); continue; }
      c.x = snap(c.x); c.y = snap(c.y);
      if (!FRAMINGS.includes(c.framing)) c.framing = "upper body";
      const items = outfitItems(r);
      const drops: string[] = [];
      for (const d of c.drop_outfit ?? []) {
        const dl = String(d).toLowerCase().trim();
        const hit = items.filter((it) => it.toLowerCase() === dl || it.toLowerCase().includes(dl) || (dl.includes(it.toLowerCase()) && it.length > 3));
        if (hit.length === 1) { drops.push(hit[0]); stats.outfit_dropped.push(`p${p.id} ${c.name}: ${hit[0]}`); log.push(`p${p.id}: ${c.name} outfit item dropped for the scene: "${hit[0]}"`); }
        else log.push(`p${p.id}: ${c.name} drop_outfit "${d}" ignored (not one item of the outfit)`);
      }
      c.drop_outfit = drops;
      chars.push(c);
    }
    const used = new Set<number>();
    for (const c of chars) {
      let k = 0;
      while (used.has(c.x) && k++ < 5) { c.x = GRID[(GRID.indexOf(c.x) + 1) % 5]; log.push(`p${p.id}: moved ${c.name} x (same column)`); }
      used.add(c.x);
    }
    nai.characters = chars;
    // layout rules
    if (!LAYOUTS.includes(p.layout) || (p.layout as string) === "text_on_white") p.layout = "full_width";
    if (p.layout === "title" && i > 0) { p.layout = "full_width"; log.push(`p${p.id}: title only on the first panel -> full_width`); }
    const tallFor = () => (chars.length >= 2 && p.size === "1216x832" ? "1216x832" : "832x1216");
    if (p.layout === "wide_band" && p.beat === "reaction") { p.layout = "tight_crop"; log.push(`p${p.id}: wide_band on a reaction beat -> tight_crop`); }
    if (p.layout === "wide_band" && !["establishing", "insert", "title"].includes(p.beat)) {
      p.layout = "full_width"; p.size = tallFor(); stats.layout_repaired++; log.push(`p${p.id}: wide_band on a ${p.beat} beat -> full_width ${p.size}`);
    }
    if (p.layout === "wide_band") p.size = "1472x704";
    if (p.layout === "tight_crop" && !(["reaction", "insert"].includes(p.beat) || chars.every((c) => c.framing === "portrait" || c.framing === "hands only"))) {
      p.layout = "full_width"; p.size = "832x1216"; stats.layout_repaired++; log.push(`p${p.id}: tight_crop on a ${p.beat} beat -> full_width 832x1216`);
    }
    if (p.layout === "tight_crop" && !["1216x832", "1472x704"].includes(p.size)) p.size = "1216x832";
    if (p.layout.startsWith("inset") && !["832x1216", "1024x1024"].includes(p.size)) { p.size = "832x1216"; stats.size_repaired++; }
    if (p.layout !== "wide_band" && p.size === "1472x704" && chars.length) { p.size = "1216x832"; stats.size_repaired++; log.push(`p${p.id}: 1472x704 with characters outside a band -> 1216x832`); }
    // caps: balloons and narration
    const out: TextItem[] = []; let nb = 0, nn = 0;
    for (const t of p.text) {
      if (t.type === "speech" || t.type === "thought") { if (++nb > LIMITS.maxBalloons) { stats.balloons_dropped++; log.push(`p${p.id}: dropped balloon #${nb} "${t.text}"`); continue; } }
      if (t.type === "narration") { if (++nn > LIMITS.maxNarrImage) { stats.balloons_dropped++; log.push(`p${p.id}: dropped narration #${nn}`); continue; } }
      out.push(t);
    }
    // narration at a top anchor is read before the balloons: keep it first
    p.text = [...out.filter((t) => t.type === "narration" && !t.anchor.startsWith("bottom") && t.anchor !== "over-bottom-edge"),
              ...out.filter((t) => !(t.type === "narration" && !t.anchor.startsWith("bottom") && t.anchor !== "over-bottom-edge"))];
    if (p.beat === "action" && !p.text.some((t) => t.type === "sfx")) { stats.sfx_missing_action++; log.push(`p${p.id}: action beat without sfx`); }
  });
  for (const p of kept) if (p.kind === "text_beat") p.text = p.text.slice(0, LIMITS.maxNarrBeat);

  // portrait bias: >= 60% of the character panels (not bands/crops) portrait or tall
  const charPanels = () => imgs.filter((p) => p.nai.characters.length && !["wide_band", "tight_crop"].includes(p.layout));
  const share = () => charPanels().filter((p) => PORTRAIT_SIZES.includes(p.size)).length / Math.max(1, charPanels().length);
  for (const p of charPanels()) {
    if (share() >= LIMITS.portraitShare) break;
    if (!PORTRAIT_SIZES.includes(p.size) && p.nai.characters.length === 1) { log.push(`p${p.id}: ${p.size} -> 832x1216 (portrait bias)`); p.size = "832x1216"; stats.size_repaired++; }
  }
  // at least one inset
  if (!imgs.some((p) => p.layout.startsWith("inset"))) {
    const cand = imgs.find((p, i) => i > 0 && p.layout === "full_width" && p.nai.characters.length === 1 && ["dialogue", "reaction", "quiet"].includes(p.beat) && ["832x1216", "1024x1024"].includes(p.size));
    if (cand) {
      const first = cand.text.find((t) => t.type === "speech" || t.type === "thought");
      cand.layout = first && first.anchor.includes("left") ? "inset_right" : "inset_left";
      stats.layout_repaired++; log.push(`p${cand.id}: full_width -> ${cand.layout} (inset quota)`);
    }
  }
  const props = sb.key_props ?? [];
  const inserts = imgs.filter((p) => p.beat === "insert").map((p) => `${p.moment ?? ""} ${p.shot ?? ""} ${p.nai.base}`.toLowerCase()).join(" ");
  Object.assign(stats, {
    props_without_insert: props.filter((pr) => !normWords(pr).some((w) => w.length > 3 && inserts.includes(w))).length,
    image_panels: imgs.length, text_beats: kept.length - imgs.length,
    layouts: imgs.map((p) => p.layout), sizes: imgs.map((p) => p.size), portrait_share: Number(share().toFixed(2)),
    balloons: kept.reduce((n, p) => n + p.text.filter((t) => t.type === "speech" || t.type === "thought").length, 0),
    narration: kept.reduce((n, p) => n + p.text.filter((t) => t.type === "narration").length, 0),
    sfx: kept.reduce((n, p) => n + p.text.filter((t) => t.type === "sfx").length, 0),
    max_words: Math.max(0, ...kept.flatMap((p) => p.text.filter((t) => t.type === "speech" || t.type === "thought").map((t) => t.text.split(/\s+/).length))),
  });
  sb.panels = kept;
  return { storyboard: sb, log, stats };
}
