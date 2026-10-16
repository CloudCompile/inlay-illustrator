/**
 * Webtoon storyboard: shape, code validation and repair of the planner's JSON (round 1 of the webtoon bench,
 * `webtoon-bench/scripts/plan.py`). Pure.
 *
 * Rules: 6..8 image panels (hard), sizes / layouts / anchors / framings from fixed lists, coordinates snapped to the
 * 5x5 grid and no two characters in one column, speech and thought sentences must appear word for word in the
 * source (a near match >= 0.85 is replaced by the source words, else dropped), at most 2 balloons and 1 narration per
 * image panel, balloons over 12 words split at a sentence end, a layout quota (>= 3 non-full-width incl. one inset).
 */

export const WEBTOON_GRID = [0.1, 0.3, 0.5, 0.7, 0.9] as const;
export const WEBTOON_SIZES = ["832x1216", "1216x832", "1024x1024", "704x1472", "1472x704"] as const;
export const WEBTOON_LAYOUTS = ["title", "full_width", "wide_band", "inset_left", "inset_right", "fade_white", "tight_crop", "text_on_white"] as const;
export const WEBTOON_ANCHORS = ["top-left", "top-right", "top", "left", "right", "bottom-left", "bottom-right", "over-top-edge", "over-bottom-edge", "gutter-above", "gutter-below"] as const;
export const WEBTOON_FRAMINGS = ["portrait", "upper body", "cowboy shot", "lower body", "full body", "hands only"] as const;
export const WEBTOON_MIN_PANELS = 6;
export const WEBTOON_MAX_PANELS = 8;
const NON_FULL = new Set(["wide_band", "inset_left", "inset_right", "fade_white", "tight_crop"]);
const MAX_BALLOON_WORDS = 12;
const QUOTE_REPAIR_RATIO = 0.85;

export type TextType = "speech" | "thought" | "narration" | "sfx";

export interface StoryText {
  type: TextType;
  speaker: string | null;
  text: string;
  anchor: string;
}

export interface StoryCharacter {
  name: string;
  x: number;
  y: number;
  framing: string;
  shoes_off: boolean;
  /** Pose / expression tags, then a newline and one English sentence. */
  prompt: string;
}

export interface StoryPanel {
  id: number;
  kind: "image" | "text_beat";
  beat: string;
  moment: string;
  shot: string;
  size: string;
  layout: string;
  scene_change: boolean;
  balloon_space: string;
  nai: { base: string; characters: StoryCharacter[] };
  text: StoryText[];
}

export interface Storyboard {
  title: string;
  key_props: string[];
  /** Outfit chosen per character for this message (roster outfit id). */
  outfits: Record<string, string>;
  panels: StoryPanel[];
}

export interface StoryboardStats {
  imagePanels: number;
  textBeats: number;
  balloons: number;
  sfx: number;
  maxWords: number;
  nonFullLayouts: number;
  inventedDropped: number;
  quoteRepaired: number;
  balloonsDropped: number;
  split: number;
  layoutRepaired: number;
  sfxMissingAction: number;
  unknownCharacters: number;
  anchorFixed: number;
}

export interface ValidationRoster {
  names: string[];
  /** Outfit ids per character name; the first one is the default. */
  outfits: Record<string, string[]>;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/* ---------------------------------------------------------------- quote check */

export function normWords(s: string): string[] {
  const t = s
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/[\u2013\u2014]/gu, " ")
    .replace(/\u2026/gu, " ... ")
    .replace(/[*_]/gu, "")
    .toLowerCase();
  return (t.match(/[a-z0-9']+/gu) ?? []).map((w) => w.replace(/^'+|'+$/gu, "")).filter(Boolean);
}

/** Checkable pieces of a balloon: sentences and "..."/dash-separated fragments. */
export function quoteFragments(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\.\.\.|\u2026|\u2014|--/u)
    .map((f) => f.trim())
    .filter((f) => normWords(f).length > 0);
}

/** difflib.SequenceMatcher(None, a, b).ratio() without the junk heuristic. */
export function sequenceRatio(a: readonly string[], b: readonly string[]): number {
  const total = a.length + b.length;
  if (!total) return 1;
  const matches = (alo: number, ahi: number, blo: number, bhi: number): number => {
    let besti = alo;
    let bestj = blo;
    let bestk = 0;
    let lengths = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map<number, number>();
      for (let j = blo; j < bhi; j += 1) {
        if (a[i] !== b[j]) continue;
        const k = (lengths.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestk) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestk = k;
        }
      }
      lengths = next;
    }
    if (!bestk) return 0;
    return bestk + matches(alo, besti, blo, bestj) + matches(besti + bestk, ahi, bestj + bestk, bhi);
  };
  return (2 * matches(0, a.length, 0, b.length)) / total;
}

/** Closest word window inside one source paragraph: [ratio, original text]. */
function repairFragment(fragment: string, source: string): [number, string | null] {
  const target = normWords(fragment);
  const n = target.length;
  let best: [number, string | null] = [0, null];
  for (const para of source.split("\n")) {
    if (!para.trim()) continue;
    const toks: Array<{ w: string; start: number; end: number }> = [];
    for (const m of para.matchAll(/[A-Za-z0-9'\u2019]+/gu)) {
      const w = m[0].replace(/^['\u2019]+|['\u2019]+$/gu, "").toLowerCase().replace(/\u2019/gu, "'");
      if (w) toks.push({ w, start: m.index!, end: m.index! + m[0].length });
    }
    const words = toks.map((t) => t.w);
    for (const len of new Set([Math.max(1, n - 1), n, n + 1])) {
      for (let i = 0; i < Math.max(1, words.length - len + 1); i += 1) {
        if (i + len > toks.length) continue;
        const r = sequenceRatio(target, words.slice(i, i + len));
        if (r > best[0]) best = [r, para.slice(toks[i]!.start, toks[i + len - 1]!.end)];
      }
    }
  }
  return best;
}

export interface QuoteNote {
  kind: "repaired" | "dropped";
  fragment: string;
  replacement: string | null;
  ratio: number;
}

/** Verbatim fragments are kept, near matches (>= 0.85) replaced by the source words, others dropped. */
export function checkQuote(text: string, source: string, sourceWords = ` ${normWords(source).join(" ")} `): { text: string | null; notes: QuoteNote[] } {
  const keep: string[] = [];
  const notes: QuoteNote[] = [];
  for (const fragment of quoteFragments(text)) {
    if (sourceWords.includes(` ${normWords(fragment).join(" ")} `)) {
      keep.push(fragment);
      continue;
    }
    const [ratio, candidate] = repairFragment(fragment, source);
    if (ratio >= QUOTE_REPAIR_RATIO && candidate) {
      const last = fragment.trimEnd().slice(-1);
      const replacement = candidate + ("!?.".includes(last) && last ? last : "");
      keep.push(replacement);
      notes.push({ kind: "repaired", fragment, replacement, ratio });
    } else notes.push({ kind: "dropped", fragment, replacement: null, ratio });
  }
  return { text: keep.length ? keep.join(" ") : null, notes };
}

/** A balloon over 12 words is split in two at a sentence end (unchanged when it has one sentence). */
export function splitLong(text: string, maxWords = MAX_BALLOON_WORDS): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length <= maxWords) return [text];
  const parts = text.split(/(?<=[.!?])\s+/u);
  if (parts.length < 2) return [text];
  const a: string[] = [];
  const b: string[] = [];
  let acc = 0;
  for (const p of parts) {
    (acc + p.split(/\s+/u).length <= Math.floor((words.length + 1) / 2) || !a.length ? a : b).push(p);
    acc += p.split(/\s+/u).length;
  }
  return b.length ? [a.join(" "), b.join(" ")] : [text];
}

const snap = (v: unknown): number => {
  const n = Number(v);
  const x = Number.isFinite(n) ? n : 0.5;
  return WEBTOON_GRID.reduce((best, g) => (Math.abs(g - x) < Math.abs(best - x) ? g : best), 0.5);
};

/* ---------------------------------------------------------------- validation */

/** Image panel count inside 6..8 and every image panel has a base prompt (else the planner is asked again). */
export function storyboardHardOk(raw: unknown): boolean {
  const panels = Array.isArray(rec(raw).panels) ? (rec(raw).panels as unknown[]) : null;
  if (!panels) return false;
  const images = panels.map(rec).filter((p) => p.kind === "image");
  return images.length >= WEBTOON_MIN_PANELS && images.length <= WEBTOON_MAX_PANELS && images.every((p) => !!str(rec(p.nai).base).trim());
}

function normalizeCharacter(raw: Rec): StoryCharacter {
  return {
    name: str(raw.name).trim(),
    x: snap(raw.x),
    y: snap(raw.y),
    framing: (WEBTOON_FRAMINGS as readonly string[]).includes(str(raw.framing)) ? str(raw.framing) : "upper body",
    shoes_off: raw.shoes_off === true,
    prompt: str(raw.prompt).trim(),
  };
}

/** Normalize, check and repair a planner storyboard. `log` lists every change in plain English. */
export function validateStoryboard(raw: unknown, roster: ValidationRoster, source: string): { storyboard: Storyboard; log: string[]; stats: StoryboardStats } {
  const log: string[] = [];
  const stats: StoryboardStats = {
    imagePanels: 0, textBeats: 0, balloons: 0, sfx: 0, maxWords: 0, nonFullLayouts: 0,
    inventedDropped: 0, quoteRepaired: 0, balloonsDropped: 0, split: 0, layoutRepaired: 0, sfxMissingAction: 0, unknownCharacters: 0, anchorFixed: 0,
  };
  const names = new Set(roster.names);
  const sourceWords = ` ${normWords(source).join(" ")} `;
  const r = rec(raw);
  const panels: StoryPanel[] = [];
  const rawPanels = Array.isArray(r.panels) ? r.panels.map(rec) : [];
  for (const [i, p] of rawPanels.entries()) {
    const id = Number.isSafeInteger(Number(p.id)) ? Number(p.id) : i + 1;
    const kind = p.kind === "image" ? "image" : "text_beat";
    const panel: StoryPanel = {
      id,
      kind,
      beat: str(p.beat) || (kind === "image" ? "dialogue" : "quiet"),
      moment: str(p.moment),
      shot: str(p.shot),
      size: str(p.size),
      layout: str(p.layout),
      scene_change: p.scene_change === true,
      balloon_space: str(p.balloon_space),
      nai: { base: str(rec(p.nai).base).trim(), characters: [] },
      text: [],
    };
    if (kind === "image") {
      if (!(WEBTOON_SIZES as readonly string[]).includes(panel.size)) {
        log.push(`p${id}: bad size "${panel.size}" -> 832x1216`);
        panel.size = "832x1216";
      }
      const used = new Set<number>();
      for (const c of Array.isArray(rec(p.nai).characters) ? (rec(p.nai).characters as unknown[]).map(rec) : []) {
        const ch = normalizeCharacter(c);
        if (!names.has(ch.name)) {
          stats.unknownCharacters += 1;
          log.push(`p${id}: dropped unknown character "${ch.name}"`);
          continue;
        }
        let guard = 0;
        while (used.has(ch.x) && guard++ < WEBTOON_GRID.length) {
          ch.x = WEBTOON_GRID[(WEBTOON_GRID.indexOf(ch.x as never) + 1) % WEBTOON_GRID.length]!;
          log.push(`p${id}: moved ${ch.name} x (same column)`);
        }
        used.add(ch.x);
        panel.nai.characters.push(ch);
      }
    } else panel.layout = "text_on_white";

    const texts: StoryText[] = [];
    for (const t of Array.isArray(p.text) ? p.text.map(rec) : []) {
      const text = str(t.text).trim();
      if (!text) continue;
      const type: TextType = t.type === "speech" || t.type === "thought" || t.type === "narration" ? t.type : "sfx";
      let anchor = str(t.anchor);
      if (!(WEBTOON_ANCHORS as readonly string[]).includes(anchor)) {
        anchor = "top-left";
        stats.anchorFixed += 1;
      }
      const item: StoryText = { type, speaker: str(t.speaker).trim() || null, text, anchor };
      if (type !== "speech" && type !== "thought") {
        texts.push(item);
        continue;
      }
      const checked = checkQuote(text, source, sourceWords);
      for (const note of checked.notes) {
        if (note.kind === "repaired") {
          stats.quoteRepaired += 1;
          log.push(`p${id}: quote repaired (${note.ratio.toFixed(2)}) "${note.fragment}" -> "${note.replacement}"`);
        } else {
          stats.inventedDropped += 1;
          log.push(`p${id}: dropped invented sentence (${note.ratio.toFixed(2)}) "${note.fragment}"`);
        }
      }
      if (!checked.text) continue;
      const parts = splitLong(checked.text);
      if (parts.length > 1) {
        stats.split += 1;
        log.push(`p${id}: split ${checked.text.split(/\s+/u).length}-word balloon`);
      }
      for (const part of parts) texts.push({ ...item, text: part });
    }
    let balloons = 0;
    let narrations = 0;
    for (const t of texts) {
      if (t.type === "speech" || t.type === "thought") {
        balloons += 1;
        if (balloons > 2) {
          stats.balloonsDropped += 1;
          log.push(`p${id}: dropped balloon #${balloons} "${t.text}"`);
          continue;
        }
      }
      if (t.type === "narration") {
        narrations += 1;
        if (narrations > (kind === "image" ? 1 : 3)) {
          stats.balloonsDropped += 1;
          log.push(`p${id}: dropped narration #${narrations}`);
          continue;
        }
      }
      panel.text.push(t);
    }
    if (panel.beat === "action" && !panel.text.some((t) => t.type === "sfx")) {
      stats.sfxMissingAction += 1;
      log.push(`p${id}: action beat without sfx`);
    }
    panels.push(panel);
  }

  const images = panels.filter((p) => p.kind === "image");
  const nonFull = () => images.filter((p) => NON_FULL.has(p.layout)).length;
  const hasInset = () => images.some((p) => p.layout.startsWith("inset"));
  for (const p of images) {
    if (!NON_FULL.has(p.layout) && p.layout !== "full_width" && p.layout !== "title") p.layout = "full_width";
    if (p.layout === "wide_band" && p.size !== "1472x704") p.size = "1472x704";
  }
  for (const p of images) {
    if (nonFull() >= 3) break;
    if (p.layout === "full_width" && p.size === "1472x704") {
      p.layout = "wide_band";
      stats.layoutRepaired += 1;
      log.push(`p${p.id}: full_width 1472x704 -> wide_band`);
    }
  }
  let side = "inset_right";
  for (const p of images) {
    if (nonFull() >= 3 && hasInset()) break;
    if (p.layout === "full_width" && (p.size === "832x1216" || p.size === "1024x1024") && p.nai.characters.length <= 1) {
      p.layout = side;
      side = side === "inset_right" ? "inset_left" : "inset_right";
      stats.layoutRepaired += 1;
      log.push(`p${p.id}: full_width -> ${p.layout} (quota)`);
    }
  }

  const outfits: Record<string, string> = {};
  const rawOutfits = rec(r.outfits);
  for (const name of roster.names) {
    const allowed = roster.outfits[name] ?? [];
    const pick = str(rawOutfits[name]);
    if (!allowed.length) continue;
    outfits[name] = allowed.includes(pick) ? pick : allowed[0]!;
    if (pick && !allowed.includes(pick)) log.push(`${name}: unknown outfit "${pick}" -> ${allowed[0]}`);
  }

  const all = panels.flatMap((p) => p.text);
  Object.assign(stats, {
    imagePanels: images.length,
    textBeats: panels.length - images.length,
    balloons: all.filter((t) => t.type === "speech" || t.type === "thought").length,
    sfx: all.filter((t) => t.type === "sfx").length,
    maxWords: Math.max(0, ...all.filter((t) => t.type === "speech" || t.type === "thought").map((t) => t.text.split(/\s+/u).length)),
    nonFullLayouts: nonFull(),
  });
  return {
    storyboard: { title: str(r.title).trim(), key_props: Array.isArray(r.key_props) ? r.key_props.map(str).filter(Boolean) : [], outfits, panels },
    log,
    stats,
  };
}
