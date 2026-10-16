/**
 * Code validation + repair of the manga planner output (pure; every change is logged). Shares the webtoon validator's quote
 * check and character checks, then the manga rules: importance, one source line per balloon (two lines from different moments
 * joined into one balloon keep only the first), short balloons (long lines split at sentence breaks), shout / whisper tone,
 * balloon and narration caps, no suggestive pose tags, no "head out of frame" (NovelAI drew an empty band with a panel line),
 * the page split + image size per panel, and at most one frame-break per page.
 */
import { BEATS, type Beat, type ImagePanel, type Importance, type PlannerCharacter, type Storyboard, type TextItem } from "./storyboard-schema.js";
import { buildQuoteIndex, checkedQuote, fragments, normWords, validateCharacters } from "./storyboard-validate.js";
import { mangaPagePlan } from "./manga-layout.js";

export const MANGA_LIMITS = { words: 8, balloons: { small: 2, normal: 3, big: 3 } as Record<Importance, number>, narration: 2, joinGapWords: 60 };
const IMPORTANCE: readonly Importance[] = ["small", "normal", "big"];
const SUGGESTIVE = /^(?:panting|heavy breathing|spread legs|straddling|seductive smile|bedroom eyes)$/iu;
const EMPTY_BAND = /^head out of frame$/iu;
const WIDE = new Set(["1600x640", "1472x704"]);

/** Image panel counts in range and every panel has a base prompt. */
export function mangaHardOk(raw: any, range: { min: number; max: number }): boolean {
  try {
    const panels = raw.panels.filter((p: any) => p && typeof p === "object");
    return panels.length >= range.min && panels.length <= range.max && panels.every((p: any) => typeof p.nai?.base === "string" && p.nai.base.trim());
  } catch {
    return false;
  }
}

const wordCount = (s: string) => s.split(/\s+/u).filter(Boolean).length;

/** A long balloon -> short beats: split at sentence breaks (else at a comma or "..."), parts of about MANGA_LIMITS.words words. */
export function splitBalloon(text: string): string[] {
  if (wordCount(text) <= MANGA_LIMITS.words) return [text];
  let parts = text.split(/(?<=[.!?\u2026])\s+/u);
  if (parts.length < 2) parts = text.split(/(?<=,|\.\.\.)\s+/u);
  if (parts.length < 2) return [text];
  const chunks: string[] = [];
  for (const part of parts) {
    const last = chunks.at(-1);
    if (last !== undefined && (wordCount(last) + wordCount(part) <= MANGA_LIMITS.words || wordCount(last) < 3)) chunks[chunks.length - 1] = `${last} ${part}`;
    else chunks.push(part);
  }
  if (chunks.length > 1 && wordCount(chunks.at(-1)!) < 3) chunks.splice(-2, 2, `${chunks.at(-2)} ${chunks.at(-1)}`);
  return chunks.length > 3 ? [...chunks.slice(0, 2), chunks.slice(2).join(" ")] : chunks;
}

/** Fragments of one balloon that come from far apart in the source (two different lines joined): keep the first group only. */
export function falseJoin(text: string, source: string): { text: string; dropped: string[] } {
  const frags = fragments(text);
  if (frags.length < 2) return { text, dropped: [] };
  const hay = normWords(source);
  const find = (words: string[], from: number) => {
    for (let i = from; i + words.length <= hay.length; i++) if (words.every((w, k) => hay[i + k] === w)) return i;
    return -1;
  };
  let end = -1;
  for (const [k, f] of frags.entries()) {
    const words = normWords(f);
    if (!words.length) continue;
    const at = find(words, Math.max(0, end));
    if (end >= 0 && (at < 0 || at - end > MANGA_LIMITS.joinGapWords)) {
      if (at < 0 && find(words, 0) < 0) return { text, dropped: [] }; // not verbatim on its own (repaired / joined across a tag): leave it
      const kept = frags.slice(0, k).join(" ");
      return { text: kept, dropped: frags.slice(k) };
    }
    if (at >= 0) end = at + words.length;
  }
  return { text, dropped: [] };
}

function cleanTags(line: string, panelId: number, who: string, log: string[]): string {
  const [tagLine, ...rest] = line.split("\n");
  const kept = (tagLine ?? "").split(",").map((t) => t.trim()).filter((t) => {
    if (!t) return false;
    if (SUGGESTIVE.test(t) || EMPTY_BAND.test(t)) { log.push(`p${panelId}: ${who} tag "${t}" dropped`); return false; }
    return true;
  });
  return [kept.join(", "), ...rest].join("\n");
}

export function validateMangaStoryboard(raw: any, roster: PlannerCharacter[], source: string) {
  const log: string[] = [];
  const stats: Record<string, any> = { invented_dropped: 0, quote_repaired: 0, quote_joined: 0, false_joins: 0, balloons_dropped: 0, split: 0, unknown_char: 0, outfit_dropped: [] as string[], sfx_missing_action: 0 };
  const byName = new Map(roster.map((r) => [r.name, r]));
  const idx = buildQuoteIndex(source);
  const sourceWords = ` ${normWords(source).join(" ")} `;
  const rawPanels: any[] = (raw.panels ?? []).filter((p: any) => p && typeof p === "object");
  const panels: ImagePanel[] = rawPanels.map((r, i) => {
    const id = i + 1;
    if (r.id !== id) log.push(`p${r.id}: renumbered ${id}`);
    const importance: Importance = IMPORTANCE.includes(r.importance) ? r.importance : "normal";
    const beat: Beat = BEATS.includes(r.beat) && r.beat !== "title" ? r.beat : "dialogue";
    const p: ImagePanel = {
      id, kind: "image", beat, importance, size: "1024x1024", layout: "full_width",
      ...(typeof r.moment === "string" ? { moment: r.moment } : {}),
      ...(typeof r.shot === "string" ? { shot: r.shot } : {}),
      ...(r.frame_break === true ? { frame_break: true } : {}),
      nai: { base: cleanTags(String(r.nai?.base ?? ""), id, "base", log), characters: Array.isArray(r.nai?.characters) ? r.nai.characters.filter((c: any) => c && typeof c === "object") : [] },
      text: [],
    };
    p.nai.characters = validateCharacters(p, byName, log, stats).map((c) => ({ ...c, prompt: cleanTags(String(c.prompt ?? ""), id, c.name, log) }));

    const out: TextItem[] = [];
    for (const t0 of Array.isArray(r.text) ? r.text : []) {
      if (!t0 || !["speech", "thought", "narration", "sfx"].includes(t0.type) || !String(t0.text ?? "").trim()) continue;
      const t: TextItem = { type: t0.type, speaker: typeof t0.speaker === "string" ? t0.speaker : null, text: String(t0.text).trim(), anchor: "top" };
      if (t.type === "speech" || t.type === "thought") {
        let text = checkedQuote(id, t.text, idx, log, stats);
        if (!text) continue;
        const joined = falseJoin(text, source);
        if (joined.dropped.length) { stats.false_joins++; log.push(`p${id}: dropped "${joined.dropped.join(" ")}" (a different line joined into one balloon)`); text = joined.text; }
        if (t.type === "speech" && (t0.tone === "shout" || t0.tone === "whisper")) t.tone = t0.tone;
        const parts = splitBalloon(text);
        if (parts.length > 1) { stats.split++; log.push(`p${id}: split ${wordCount(text)}-word balloon into ${parts.length}`); }
        for (const part of parts) out.push({ ...t, text: part });
        continue;
      }
      if (t.type === "sfx") stats.sfx_from_source = (stats.sfx_from_source ?? 0) + (sourceWords.includes(` ${normWords(t.text).join(" ")} `) ? 1 : 0);
      out.push(t);
    }
    let balloons = 0, narration = 0;
    p.text = out.filter((t) => {
      if (t.type === "speech" || t.type === "thought") {
        if (++balloons <= MANGA_LIMITS.balloons[importance]) return true;
        stats.balloons_dropped++; log.push(`p${id}: dropped balloon #${balloons} "${t.text}" (${importance} panel)`); return false;
      }
      if (t.type === "narration" && ++narration > MANGA_LIMITS.narration) { stats.balloons_dropped++; log.push(`p${id}: dropped narration #${narration}`); return false; }
      return true;
    });
    if (p.beat === "action" && !p.text.some((t) => t.type === "sfx")) { stats.sfx_missing_action++; log.push(`p${id}: action beat without sfx`); }
    return p;
  });

  // a small cell holds one short balloon: a small panel with more text gets a normal cell
  for (const p of panels) {
    const lines = p.text.filter((t) => t.type === "speech" || t.type === "thought");
    if (p.importance === "small" && (lines.length > 1 || lines.reduce((n, t) => n + wordCount(t.text), 0) > MANGA_LIMITS.words)) {
      p.importance = "normal";
      log.push(`p${p.id}: small -> normal (${lines.length} balloons)`);
    }
  }

  // pages and image sizes (the image size follows the page cell)
  const plan = mangaPagePlan(panels);
  for (const p of panels) p.size = plan.sizes[p.id] as ImagePanel["size"];

  // frame-breaks: at most one per page, on an action beat with one character, not in a small or wide cell; none marked -> the first eligible panel
  // (the lowered frame top leaves less room for text: at most 2 balloons)
  const breakable = (p: ImagePanel) => p.beat === "action" && p.nai.characters.length === 1 && p.importance !== "small" && !WIDE.has(p.size)
    && !["hands only", "lower body"].includes(p.nai.characters[0]!.framing) && p.text.filter((t) => t.type === "speech" || t.type === "thought").length <= 2;
  for (const page of plan.pages) {
    let used = false;
    for (const id of page.panels) {
      const p = panels.find((q) => q.id === id)!;
      if (!p.frame_break) continue;
      if (!breakable(p)) { delete p.frame_break; log.push(`p${id}: frame_break dropped (needs an action beat with one character in a normal or big cell)`); continue; }
      if (used) { delete p.frame_break; log.push(`p${id}: frame_break dropped (at most 1 per page)`); continue; }
      used = true;
    }
  }
  if (!panels.some((p) => p.frame_break)) {
    const auto = panels.find(breakable);
    if (auto) { auto.frame_break = true; log.push(`p${auto.id}: frame_break added (none of the planner's marks was usable)`); }
  }
  for (const p of panels) {
    const c = p.frame_break ? p.nai.characters[0]! : null;
    if (c && c.y > 0.5) { log.push(`p${p.id}: ${c.name} y ${c.y} -> 0.5 (frame-break)`); c.y = 0.5; }
  }

  const sb: Storyboard = { title: String(raw.title ?? ""), key_props: Array.isArray(raw.key_props) ? raw.key_props : [], panels, pages: plan.pages };
  Object.assign(stats, {
    image_panels: panels.length,
    pages: plan.pages.map((p) => p.template),
    importance: panels.map((p) => p.importance),
    sizes: panels.map((p) => p.size),
    frame_breaks: panels.filter((p) => p.frame_break).map((p) => p.id),
    balloons: panels.reduce((n, p) => n + p.text.filter((t) => t.type === "speech" || t.type === "thought").length, 0),
    narration: panels.reduce((n, p) => n + p.text.filter((t) => t.type === "narration").length, 0),
    sfx: panels.reduce((n, p) => n + p.text.filter((t) => t.type === "sfx").length, 0),
    max_words: Math.max(0, ...panels.flatMap((p) => p.text.filter((t) => t.type === "speech" || t.type === "thought").map((t) => wordCount(t.text)))),
  });
  return { storyboard: sb, log, stats };
}
