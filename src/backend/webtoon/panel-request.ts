/**
 * Storyboard panel -> NovelAI V5 request through the engine dispatcher (round 1 of the webtoon bench,
 * `webtoon-bench/scripts/images.py build_jobs`). Pure.
 *
 * Base prompt = count tags + style (artist / quality) + the planner's camera and scene tags (+ its sentence).
 * Character prompt = identity tags + the planner's pose tags + the chosen outfit's parts weighted by framing
 * (`outfitPartFramingWeights`), key outfit tags weighted up (legs / feet 1.3, outer top garment 1.2) because NovelAI
 * drops them otherwise; `shoes_off` replaces the feet tags by "no shoes". `use_coords` with the planner's centers.
 */
import type { StoryCharacter, StoryPanel } from "./storyboard-schema.js";

export type OutfitPart = "head" | "top" | "bottom" | "legs" | "feet";
const PARTS: readonly OutfitPart[] = ["head", "top", "bottom", "legs", "feet"];
const OUTER_TOP = /jacket|blazer|coat|hoodie|cardigan|gakuran|sweater|uniform|apron|undershirt/iu;
const HANDS_ONLY: Record<OutfitPart, number> = { head: 0, top: 0.5, bottom: 0, legs: 0, feet: 0 };
/** Added to every webtoon negative: all text is lettered on top of the image. */
export const WEBTOON_NEGATIVE = "speech bubble, text, english text, comic, multiple panels, border";

export interface WebtoonCastMember {
  name: string;
  gender: string;
  /** Identity tags (gender word + base prompt groups). */
  identity: string;
  outfitId: string;
  outfit: Partial<Record<OutfitPart, string>>;
}

export interface WebtoonStyle {
  /** Artist + quality tags. */
  style: string;
  negative: string;
  /** NovelAI parameters (sampler, noiseSchedule, steps, scale, cfgRescale, qualityToggle). */
  params: Record<string, unknown>;
  framingWeights: Record<string, Record<string, number>>;
}

export interface PanelRequest {
  panelId: number;
  width: number;
  height: number;
  prompt: string;
  negativePrompt: string;
  characters: Array<{ name: string; prompt: string; x: number; y: number }>;
  /** Weighted key outfit tags per character (for a later identity / outfit check). */
  keyTags: Record<string, string[]>;
}

const tags = (s: string | undefined) => (s ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function outfitPrompt(outfit: WebtoonCastMember["outfit"], framing: string, weights: WebtoonStyle["framingWeights"], shoesOff: boolean): { prompt: string; keyTags: string[] } {
  const w: Record<string, number> = framing === "hands only" ? HANDS_ONLY : Object.fromEntries(PARTS.map((p) => [p, weights[p]?.[framing] ?? 1]));
  const out: string[] = [];
  const keyTags: string[] = [];
  for (const part of PARTS) {
    const wp = w[part] ?? 1;
    if (part === "feet" && shoesOff) {
      if (wp > 0) out.push("no shoes");
      continue;
    }
    const list = tags(outfit[part]);
    if (!list.length || wp <= 0) continue;
    for (const t of list) {
      const key = ((part === "legs" || part === "feet") && wp >= 0.8) || (part === "top" && wp >= 1 && OUTER_TOP.test(t));
      if (key) {
        out.push(`${fmt(part === "legs" || part === "feet" ? 1.3 : 1.2)}::${t}::`);
        keyTags.push(t);
      } else out.push(wp < 1 ? `${fmt(wp)}::${t}::` : t);
    }
  }
  return { prompt: out.join(", "), keyTags };
}

/** "1girl, 1boy" / "2girls" / "no humans". */
export function countTags(genders: readonly string[]): string {
  const f = genders.filter((g) => g === "female").length;
  const m = genders.filter((g) => g === "male").length;
  const o = genders.length - f - m;
  const parts = [f ? `${f}girl${f > 1 ? "s" : ""}` : "", m ? `${m}boy${m > 1 ? "s" : ""}` : "", o ? `${o}other${o > 1 ? "s" : ""}` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "no humans";
}

/** "tags\nsentence" -> [tags, sentence]. */
function splitPrompt(p: string): [string, string] {
  const i = p.indexOf("\n");
  const head = (i < 0 ? p : p.slice(0, i)).trim().replace(/^,+|,+$/gu, "").trim();
  return [head, i < 0 ? "" : p.slice(i + 1).trim()];
}

export function dedupeTags(s: string): string {
  const seen = new Set<string>();
  return tags(s).filter((t) => (seen.has(t.toLowerCase()) ? false : (seen.add(t.toLowerCase()), true))).join(", ");
}

export function buildPanelRequest(panel: StoryPanel, cast: ReadonlyMap<string, WebtoonCastMember>, style: WebtoonStyle): PanelRequest {
  const chars = panel.nai.characters.filter((c) => cast.has(c.name));
  const [baseTags, baseSentence] = splitPrompt(panel.nai.base);
  const prompt = [countTags(chars.map((c) => cast.get(c.name)!.gender)), style.style, baseTags].filter(Boolean).join(", ") + (baseSentence ? `\n${baseSentence}` : "");
  const keyTags: Record<string, string[]> = {};
  const characters = chars.map((c: StoryCharacter) => {
    const member = cast.get(c.name)!;
    const [poseTags, sentence] = splitPrompt(c.prompt);
    const outfit = outfitPrompt(member.outfit, c.framing, style.framingWeights, c.shoes_off);
    keyTags[c.name] = outfit.keyTags;
    return { name: c.name, prompt: [member.identity, poseTags, outfit.prompt].filter(Boolean).join(", ") + (sentence ? `\n${sentence}` : ""), x: c.x, y: c.y };
  });
  const [width, height] = panel.size.split("x").map(Number) as [number, number];
  return { panelId: panel.id, width, height, prompt, negativePrompt: style.negative, characters, keyTags };
}

/** Engine `ImageRequest` (provider "novelai") for the dispatcher: fixed centers, `use_coords` forced on, no NSFW prefix. */
export function engineImageRequest(request: PanelRequest, style: WebtoonStyle, seed: string): Record<string, unknown> & { provider: "novelai" } {
  return {
    provider: "novelai",
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    seed,
    width: request.width,
    height: request.height,
    forceNsfwPrefix: false,
    config: {
      ...style.params,
      analysisProfile: "v5-hybrid",
      width: request.width,
      height: request.height,
      useOrder: true,
      useCoords: true,
      forceCharacterCoordinates: true,
      characterPrompts: request.characters.map((c) => ({ prompt: c.prompt, uc: "", centerX: c.x, centerY: c.y, coordinateMode: "fixed" })),
    },
    references: [],
    queueMeta: { kind: "generation", source: "webtoon", sourceImageToken: `webtoon:panel:${request.panelId}` },
  };
}
