/**
 * Storyboard panel -> NovelAI V5 request through the engine dispatcher (webtoon bench round 2,
 * `webtoon-bench2/scripts/images.py build_jobs` / `identity_prompt` / `outfit_prompt`; no Jev retry boosts). Pure.
 *
 * Base prompt = count tags + style (artist / quality) + the planner's camera and scene tags (+ its sentence).
 * Character prompt = identity tags + the planner's pose tags + the chosen outfit's parts weighted by framing
 * (`outfitPartFramingWeights`), key outfit tags weighted up (legs / feet 1.3, outer top garment 1.2) because NovelAI
 * drops them otherwise; `shoes_off` replaces the feet tags by "no shoes"; `drop_outfit` items (validated) are left out.
 * Identity tags are reordered gender -> character tag -> species group (weighted 1.3 for anthro characters, kemonomimi ear
 * tags dropped, a character negative against human faces) -> hair (single hair colour weighted 1.1) -> rest.
 * `use_coords` with the planner's centers.
 */
import type { ImagePanel, StoryCharacter } from "./storyboard-schema.js";

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
  characters: Array<{ name: string; prompt: string; uc: string; x: number; y: number }>;
  /** Weighted key outfit tags per character (for a later identity / outfit check). */
  keyTags: Record<string, string[]>;
  /**
   * Frame-break panel: the transparent cut-out's prompts. Base = camera tags + the transparency tags (no place); characters (same order) =
   * identity + pose without scene objects + outfit, no sentence. Props in the scene come from the inpainting step.
   */
  cutout?: { prompt: string; characters: string[] };
}

/** NovelAI V5 draws a real alpha channel with these (nai-alpha bench, route 1). */
export const TRANSPARENT_TAGS = "transparent background, has alpha";
/** Added to the cut-out's negative: free-floating effect lines on the transparent background would cross the frame on their own. */
export const CUTOUT_NEGATIVE = "motion lines, speed lines, emphasis lines";
/** Camera / framing tags of the planner's base; everything else there is place, light or props (left out of a cut-out). */
const CAMERA = /^(?:(?:extreme )?close-up|portrait|upper body|cowboy shot|full body|lower body|(?:very )?wide shot|medium shot|from (?:below|above|side|behind)|(?:low|high)[- ]angle|pov(?: hands)?|dutch angle|[a-z]+ focus|profile|straight-on|head out of frame)$/iu;

/** Furniture and fixtures: a cut-out pose tag naming one is left out (the cut-out would carry it over the frame). */
const SCENE_OBJECT = /\b(?:door|doorway|screen|shoji|wall|window|fence|railing|table|desk|chair|bench|bed|futon|couch|sofa|counter|shelf|cabinet|locker|car|tree|floor|ground|stairs|gate|pillar|post|sink|stove|fridge|refrigerator|mirror|curtain)s?\b/iu;
const HELD = /^(?:holding|carrying|hugging|grabbing|clutching|wielding|lifting|raising)\b/iu;
const BODY = /\b(?:shoulders?|hips?|chest|face|head|cheeks?|mouth|chin|knees?|back|hair|lap|waist|arms?|hands?|legs?|eyes?|ears?|neck|stomach|thighs?)\b/iu;
const RELATION = /^(.*?)\s+(?:on|against|at|behind|beside|near|by|into|through|under|over|across|onto|toward|towards|in front of|inside|out of)\s+(.+)$/iu;
const POSTURE = /^(?:sitting|standing|kneeling|lying|leaning|crouching|squatting|reclining)$/iu;

/**
 * Pose tags for a cut-out: tags that tie the character to the scene ("hand on shoji screen", "sliding door closed") are left out,
 * a posture keeps its verb ("sitting on bed" -> "sitting"); held items, gaze, body-relative poses and camera tags stay.
 */
export function cutoutPose(poseTags: string, placeTags: readonly string[]): string {
  const place = placeTags.map((t) => t.toLowerCase()).filter((t) => t.length > 3);
  const scene = (s: string) => SCENE_OBJECT.test(s) || place.some((p) => s.toLowerCase().includes(p));
  return tags(poseTags)
    .flatMap((t) => {
      if (CAMERA.test(t)) return [t];
      if (HELD.test(t) || /^looking\b/iu.test(t)) return scene(t) ? [] : [t];
      const relation = RELATION.exec(t);
      if (relation) return BODY.test(relation[2]!) && !scene(relation[2]!) ? [t] : POSTURE.test(relation[1]!.trim()) ? [relation[1]!.trim()] : [];
      return scene(t) ? [] : [t];
    })
    .join(", ");
}

const tags = (s: string | undefined) => (s ?? "").split(",").map((t) => t.trim()).filter(Boolean);
const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function outfitPrompt(outfit: WebtoonCastMember["outfit"], framing: string, weights: WebtoonStyle["framingWeights"], shoesOff: boolean, drop: readonly string[] = []): { prompt: string; keyTags: string[] } {
  const w: Record<string, number> = framing === "hands only" ? HANDS_ONLY : Object.fromEntries(PARTS.map((p) => [p, weights[p]?.[framing] ?? 1]));
  const dropped = new Set(drop.map((d) => d.toLowerCase()));
  const out: string[] = [];
  const keyTags: string[] = [];
  for (const part of PARTS) {
    const wp = w[part] ?? 1;
    if (part === "feet" && shoesOff) {
      if (wp > 0) out.push("no shoes");
      continue;
    }
    const list = tags(outfit[part]).filter((t) => !dropped.has(t.toLowerCase()));
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

/* ---------------------------------------------------------------- identity (species first, weighted) */

const SPECIES = /^(furry|anthro|furry (fe)?male|kemono|snout|muzzle|fangs|.*\bfur\b.*|.*\bspots\b|.*\b(tail|scales|feathers|beak|paws|whiskers)\b|animal ears|floppy ears|(dog|cat|fox|wolf|rabbit|bunny|horse|cow|mouse|bear|tiger|lion) ears|dalmatian|(dog|cat|fox|wolf|rabbit|horse|cow|mouse|bear|tiger|lion|deer|goat|dragon|lizard|bird)|.*\bchest (fur|tuft)\b.*)$/iu;
const HAIR_COLOR = /^(pink|black|brown|blonde|blond|white|gray|grey|red|blue|green|purple|silver|orange|light brown|dark brown) hair$/iu;
const HAIR = /hair|braid|ponytail|pigtails|twintails|bangs|bob cut|bun$/iu;
const KEMONOMIMI_EARS = /^(animal ears|(dog|cat|fox|wolf|rabbit|bunny|horse|cow|mouse|bear|tiger|lion) ears)$/iu;
const SPECIES_NAME = /^(dalmatian|dog|cat|fox|wolf|rabbit|horse|cow|mouse|bear|tiger|lion|deer|goat|dragon|lizard|bird)$/iu;
const ID_WEIGHT_FURRY = 1.3;
const ID_WEIGHT_HAIR = 1.1;

export const isFurry = (identity: string) => tags(identity).some((t) => /^(furry|anthro)$/iu.test(t));
const speciesName = (identity: string) => tags(identity).find((t) => SPECIES_NAME.test(t)) ?? "animal";
const furryGenderTag = (gender: string) => (gender === "female" ? "furry female" : gender === "male" ? "furry male" : "");

export function identityPrompt(member: Pick<WebtoonCastMember, "identity" | "gender">): string {
  const furry = isFurry(member.identity);
  const ts = tags(member.identity).filter((t) => !(furry && KEMONOMIMI_EARS.test(t)));
  const gender: string[] = ts.filter((t) => t === "female" || t === "male");
  const named = ts.filter(
    (t) => t.includes("\\(") || (!gender.includes(t) && ts.indexOf(t) === gender.length && !SPECIES.test(t) && !HAIR.test(t) && t.includes(" ") && !/eyes|skin/u.test(t)),
  );
  let species = ts.filter((t) => furry && SPECIES.test(t) && !named.includes(t));
  if (furry) species = [...new Set([...["furry", "anthro", furryGenderTag(member.gender), speciesName(member.identity), "muzzle"].filter(Boolean), ...species])];
  const hair = ts.filter((t) => HAIR.test(t) && !species.includes(t) && !named.includes(t));
  const rest = ts.filter((t) => !gender.includes(t) && !named.includes(t) && !species.includes(t) && !hair.includes(t));
  const out = [...gender, ...named];
  if (species.length) out.push(`${fmt(ID_WEIGHT_FURRY)}::${species.join(", ")}::`);
  for (const t of hair) out.push(HAIR_COLOR.test(t) ? `${fmt(ID_WEIGHT_HAIR)}::${t}::` : t);
  return [...out, ...rest].join(", ");
}

export const identityNegative = (identity: string) => (isFurry(identity) ? "human, kemonomimi mode, human face, human skin" : "");

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

export function buildPanelRequest(panel: ImagePanel, cast: ReadonlyMap<string, WebtoonCastMember>, style: WebtoonStyle): PanelRequest {
  const chars = panel.nai.characters.filter((c) => cast.has(c.name));
  const [baseTags, baseSentence] = splitPrompt(panel.nai.base);
  // All visible characters anthro: the species also goes into the base caption, before the artists.
  const furry = chars.map((c) => cast.get(c.name)!).filter((m) => isFurry(m.identity));
  const species = furry.length && furry.length === chars.length
    ? `${fmt(ID_WEIGHT_FURRY)}::${[furryGenderTag(furry[0]!.gender) || "furry", "anthro", speciesName(furry[0]!.identity)].join(", ")}::`
    : "";
  const head = [countTags(chars.map((c) => cast.get(c.name)!.gender)), species, style.style];
  const prompt = [...head, baseTags].filter(Boolean).join(", ") + (baseSentence ? `\n${baseSentence}` : "");
  const keyTags: Record<string, string[]> = {};
  const cutoutCharacters: string[] = [];
  const placeTags = tags(baseTags).filter((t) => !CAMERA.test(t));
  const characters = chars.map((c: StoryCharacter) => {
    const member = cast.get(c.name)!;
    const [poseTags, sentence] = splitPrompt(c.prompt);
    const outfit = outfitPrompt(member.outfit, c.framing, style.framingWeights, c.shoes_off === true, c.drop_outfit ?? []);
    keyTags[c.name] = outfit.keyTags;
    cutoutCharacters.push([identityPrompt(member), cutoutPose(poseTags, placeTags), outfit.prompt].filter(Boolean).join(", "));
    return {
      name: c.name,
      prompt: [identityPrompt(member), poseTags, outfit.prompt].filter(Boolean).join(", ") + (sentence ? `\n${sentence}` : ""),
      uc: identityNegative(member.identity),
      x: c.x,
      y: c.y,
    };
  });
  const [width, height] = panel.size.split("x").map(Number) as [number, number];
  const cutout = panel.frame_break
    ? { prompt: [...head, ...tags(baseTags).filter((t) => CAMERA.test(t)), TRANSPARENT_TAGS].filter(Boolean).join(", "), characters: cutoutCharacters }
    : undefined;
  return { panelId: panel.id, width, height, prompt, negativePrompt: style.negative, characters, keyTags, ...(cutout ? { cutout } : {}) };
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
      characterPrompts: request.characters.map((c) => ({ prompt: c.prompt, uc: c.uc, centerX: c.x, centerY: c.y, coordinateMode: "fixed" })),
    },
    references: [],
    queueMeta: { kind: "generation", source: "webtoon", sourceImageToken: `webtoon:panel:${request.panelId}` },
  };
}
