/**
 * Garment vocabulary shared by the outfit-awareness and outfit-visibility layers (Inlay additions, not in AM).
 *
 * Covers what the image prompt gets wrong most often: legwear and footwear. `garmentsIn` finds legwear/footwear noun
 * phrases ("white knee-high socks", "black stockings", "brown loafers") with their colors; `garmentsConflict` decides
 * whether two mentions of the same slot describe different items; `isAbsenceChunk` recognizes tags that state a
 * part is not worn ("bare legs", "barefoot"), which AM's proposal policy forbids as outfit parts.
 */

export const OUTFIT_PARTS = ["head", "top", "bottom", "legs", "feet"] as const;
export type OutfitPart = (typeof OUTFIT_PARTS)[number];
export type OutfitParts = Partial<Record<OutfitPart, string>>;

export type GarmentSlot = "legs" | "feet";

export interface GarmentMention {
  slot: GarmentSlot;
  family: string;
  colors: string[];
  /** Matched phrase (modifiers + garment noun) and its span in the scanned text. */
  text: string;
  start: number;
  end: number;
}

const WEIGHTED = /^\s*-?\d+(?:\.\d+)?::([\s\S]*?)::\s*$/;

/** Text of a prompt chunk without NovelAI weight syntax (`0.8::text::` -> `text`). */
export function unweight(chunk: string): string {
  const m = WEIGHTED.exec(chunk);
  return (m ? m[1]! : chunk).trim();
}

/** Comma-separated chunks of a part prompt, trimmed, empty ones dropped. */
export function partChunks(text: string): string[] {
  return text
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

const ABSENCE =
  /^(?:bare[ -]?legs?|legs? bare|bare (?:thighs?|knees?|calf|calves|shins?|ankles?|toes|soles?)|bare[ -]?feet|feet bare|bare[ -]?foot(?:ed)?|barefoot(?:ed)?|shoeless|sockless|no (?:shoes|socks|legwear|footwear|stockings|tights|pantyhose|headwear|hat|leg ?wear|foot ?wear)|without (?:shoes|socks|legwear|footwear)|none|nothing|n\/a|-)$/i;

/** True for a chunk that states a part is not worn ("bare legs", "barefoot", "no shoes"). */
export function isAbsenceChunk(chunk: string): boolean {
  return ABSENCE.test(unweight(chunk));
}

/** A part prompt without its absence chunks ("white socks, bare legs" -> "white socks"; "barefoot" -> ""). */
export function withoutAbsence(text: string): string {
  return partChunks(text)
    .filter((c) => !isAbsenceChunk(c))
    .join(", ");
}

/** True when a part prompt names only absence ("bare legs", "barefoot") or nothing. */
export function isAbsencePart(text: string | undefined): boolean {
  return !withoutAbsence(text ?? "");
}

// Garment nouns per slot, most specific first: the scanner tries alternatives left to right.
const LEGWEAR: ReadonlyArray<readonly [string, string]> = [
  ["thighhighs", String.raw`thigh[- ]?highs|thigh[- ]?high (?:socks|stockings)|over[- ]?the[- ]?knee (?:socks|stockings)|overknee socks`],
  ["kneehighs", String.raw`knee[- ]?highs|knee[- ]?high socks|knee[- ]length socks|knee socks`],
  ["pantyhose", String.raw`pantyhose|tights`],
  ["leggings", String.raw`leggings`],
  ["legwarmers", String.raw`leg ?warmers?`],
  ["stockings", String.raw`stockings?`],
  ["socks", String.raw`(?:ankle |crew |loose |bobby |frilled |lace-trimmed )?socks?`],
];
const FOOTWEAR: ReadonlyArray<readonly [string, string]> = [
  ["uwabaki", String.raw`uwabaki|indoor shoes`],
  ["loafers", String.raw`(?:penny )?loafers?`],
  ["maryjanes", String.raw`mary ?janes?`],
  ["sneakers", String.raw`sneakers?|trainers|running shoes|athletic shoes|tennis shoes`],
  ["boots", String.raw`(?:combat |military |knee[- ]high |thigh[- ]high |ankle |rain |riding )?boots?`],
  ["heels", String.raw`high heels|stilettos?|pumps|heels`],
  ["sandals", String.raw`sandals?|flip[- ]flops?|geta`],
  ["slippers", String.raw`slippers?`],
  ["flats", String.raw`(?:ballet )?flats`],
  ["shoes", String.raw`(?:school |dress |leather |platform )?shoes?|footwear`],
];

const COLOR_WORDS = [
  "black",
  "white",
  "red",
  "blue",
  "navy",
  "brown",
  "grey",
  "gray",
  "pink",
  "purple",
  "beige",
  "green",
  "yellow",
  "orange",
  "tan",
  "cream",
  "ivory",
  "dark",
  "light",
  "nude",
  "skin-colored",
  "maroon",
  "burgundy",
  "silver",
  "gold",
  "olive",
  "khaki",
  "emerald",
  "jade",
  "mint",
  "crimson",
  "scarlet",
  "wine",
  "charcoal",
  "violet",
  "lavender",
  "lilac",
  "teal",
  "turquoise",
  "indigo",
  "cobalt",
  "camel",
  "chocolate",
] as const;
const MODIFIER = String.raw`(?:${COLOR_WORDS.join("|")}|sheer|lace|lacy|striped|ribbed|frilly|frilled|plain|cotton|wool|woolen|nylon|silk|silky|fishnet|thin|thick|opaque|semi-sheer|patterned|polka[- ]dot|plaid|argyle|knitted|worn|scuffed|polished|shiny|glossy|leather|patent|canvas|matching|long|short|tall|clean|wet|muddy|dirty|torn|ripped|school|uniform|her|his|their|the|a|pair of|pairs of|and|,)`;

// Garment words used as noun adjuncts name furniture or objects ("shoe cabinet", "sock drawer"), not worn items.
const NOT_WORN_AFTER = String.raw`(?![\s-]+(?:cabinets?|lockers?|racks?|box(?:es)?|shel(?:f|ves)|stores?|shops?|drawers?|closets?|cupboards?|cubb(?:y|ies)|horns?|polish|bags?|laces?|strings?|prints?|marks?|stalls?)\b)`;

function slotRegex(table: ReadonlyArray<readonly [string, string]>): RegExp {
  return new RegExp(String.raw`(?:\b${MODIFIER}[\s-]+){0,4}\b(?:${table.map(([, re]) => `(?:${re})`).join("|")})\b${NOT_WORN_AFTER}`, "gi");
}
const SCAN: Record<GarmentSlot, { re: RegExp; table: ReadonlyArray<readonly [string, RegExp]> }> = {
  legs: { re: slotRegex(LEGWEAR), table: LEGWEAR.map(([f, re]) => [f, new RegExp(String.raw`\b(?:${re})\b`, "i")] as const) },
  feet: { re: slotRegex(FOOTWEAR), table: FOOTWEAR.map(([f, re]) => [f, new RegExp(String.raw`\b(?:${re})\b`, "i")] as const) },
};
const COLOR_RE = new RegExp(String.raw`\b(${COLOR_WORDS.join("|")})\b`, "gi");
const LEADING_FILLER = /^(?:(?:her|his|their|the|a|pair of|pairs of|and|,)\s+)+/i;

/** Legwear or footwear mentions in free text, left to right. */
export function garmentsIn(text: string, slot: GarmentSlot): GarmentMention[] {
  const { re, table } = SCAN[slot];
  const out: GarmentMention[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let phrase = m[0];
    let start = m.index;
    const filler = LEADING_FILLER.exec(phrase);
    if (filler) {
      start += filler[0].length;
      phrase = phrase.slice(filler[0].length);
    }
    const family = table.find(([, r]) => r.test(phrase))?.[0];
    if (!family) continue;
    const colors = [...phrase.matchAll(COLOR_RE)].map((c) => normalizeColor(c[1]!));
    // Bare "heels" / "pumps" are usually the body part or a verb; only a colored or "high" mention is footwear.
    if (family === "heels" && /^(?:heels|pumps)$/i.test(phrase.trim()) && !colors.length) continue;
    out.push({ slot, family, colors: [...new Set(colors)], text: phrase, start, end: start + phrase.length });
  }
  return out;
}

const COLOR_SYNONYMS: Record<string, string> = {
  gray: "grey",
  "skin-colored": "nude",
  ivory: "white",
  cream: "white",
  emerald: "green",
  jade: "green",
  mint: "green",
  crimson: "red",
  scarlet: "red",
  wine: "burgundy",
  charcoal: "grey",
  violet: "purple",
  lavender: "purple",
  lilac: "purple",
  teal: "blue",
  turquoise: "blue",
  cobalt: "blue",
  indigo: "navy",
  khaki: "tan",
  camel: "tan",
  chocolate: "brown",
};

function normalizeColor(c: string): string {
  const v = c.toLowerCase();
  return COLOR_SYNONYMS[v] ?? v;
}

const DARK = new Set(["black", "navy", "brown", "grey", "dark", "maroon", "burgundy", "olive"]);
const LIGHT = new Set(["white", "beige", "pink", "light", "nude", "tan", "yellow", "silver"]);
// Shades that name the same color in practice ("olive plate carrier" / "green plate carrier").
const RELATED_COLORS = new Set(["olive|green", "navy|blue", "maroon|red", "burgundy|red", "maroon|burgundy", "tan|beige", "tan|brown"]);

function colorsCompatible(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return true;
  return a.some((x) =>
    b.some(
      (y) =>
        x === y ||
        RELATED_COLORS.has(`${x}|${y}`) ||
        RELATED_COLORS.has(`${y}|${x}`) ||
        (x === "dark" && DARK.has(y)) ||
        (y === "dark" && DARK.has(x)) ||
        (x === "light" && LIGHT.has(y)) ||
        (y === "light" && LIGHT.has(x)),
    ),
  );
}

// Families that can describe the same item ("stockings" for thighhighs or pantyhose, generic "socks" for kneehighs).
const SAME_ITEM: Record<string, readonly string[]> = {
  socks: ["socks", "kneehighs", "thighhighs"],
  kneehighs: ["kneehighs", "socks"],
  thighhighs: ["thighhighs", "stockings", "socks"],
  stockings: ["stockings", "thighhighs", "pantyhose"],
  pantyhose: ["pantyhose", "stockings"],
  leggings: ["leggings"],
  legwarmers: ["legwarmers", "socks", "kneehighs", "thighhighs", "stockings", "pantyhose", "leggings"],
  shoes: FOOTWEAR.map(([f]) => f),
  loafers: ["loafers", "shoes", "uwabaki"],
  maryjanes: ["maryjanes", "shoes", "flats"],
  sneakers: ["sneakers", "shoes"],
  boots: ["boots", "shoes"],
  heels: ["heels", "shoes"],
  sandals: ["sandals", "shoes"],
  slippers: ["slippers", "shoes", "uwabaki"],
  flats: ["flats", "shoes", "maryjanes"],
  uwabaki: ["uwabaki", "shoes", "slippers", "loafers"],
};

/** True when `mention` names a different item than `registered` (same slot): another garment type, or disjoint colors. */
export function garmentsConflict(registered: GarmentMention, mention: GarmentMention): boolean {
  if (registered.slot !== mention.slot) return false;
  const sameItem = (SAME_ITEM[registered.family] ?? [registered.family]).includes(mention.family) || (SAME_ITEM[mention.family] ?? []).includes(registered.family);
  if (!sameItem) return true;
  return !colorsCompatible(registered.colors, mention.colors);
}

/** Garments a part prompt registers for a slot ("white knee-high socks, black garter" -> the socks). */
export function registeredGarments(partText: string | undefined, slot: GarmentSlot): Array<GarmentMention & { chunk: string }> {
  return partChunks(partText ?? "")
    .filter((c) => !isAbsenceChunk(c))
    .flatMap((chunk) => {
      const text = unweight(chunk);
      return garmentsIn(text, slot).map((g) => ({ ...g, chunk: text }));
    });
}

/** True when a legwear part covers the feet (socks, stockings, tights), so "barefoot" removes it too. */
export function legwearCoversFeet(partText: string | undefined): boolean {
  return registeredGarments(partText, "legs").some((g) => g.family !== "leggings" && g.family !== "legwarmers");
}

/* ------------------------------------------------------------------------------------------------
 * Same outfit: an analyzer proposal that only rewords a registered outfit
 * ---------------------------------------------------------------------------------------------- */

const PLURAL_NOUNS = /(?:ss|shorts|pants|jeans|trousers|tights|leggings|glasses|overalls|panties|briefs|boxers|goggles)$/;
const NOUN_SYNONYMS: Record<string, string> = {
  miniskirt: "skirt",
  "mini-skirt": "skirt",
  slacks: "pants",
  trousers: "pants",
  tee: "t-shirt",
  tshirt: "t-shirt",
  trainer: "sneaker",
  hoody: "hoodie",
};

function garmentNoun(phrase: string): string {
  const words = phrase
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .match(/[a-z][a-z-]*/g);
  let noun = words?.at(-1) ?? "";
  // Singular: "socks" -> "sock", "dresses" -> "dress", "watches" -> "watch"; pair nouns ("shorts", "tights") stay.
  if (noun.length > 3 && /[^s]s$/.test(noun) && !PLURAL_NOUNS.test(noun)) noun = /(?:sses|shes|ches|xes)$/.test(noun) ? noun.slice(0, -2) : noun.slice(0, -1);
  return NOUN_SYNONYMS[noun] ?? noun;
}

/**
 * Garments of an outfit part: one `{noun, colors}` per garment phrase. Chunks split on "over"/"under"/"and"; details
 * after "with" ("hoodie with pouch pocket", "helmet with goggles") belong to the garment and are left out.
 */
export function partGarments(part: string | undefined): Array<{ noun: string; colors: string[] }> {
  return partChunks(part ?? "")
    .filter((c) => !isAbsenceChunk(c))
    .flatMap((chunk) =>
      unweight(chunk)
        .replace(/\s+(?:with|featuring|showing|that|which)\s+.*$/i, "")
        .split(/\s+(?:over|under|atop|beneath|and|&)\s+|\s*\/\s*/i)
        .map((phrase) => ({ noun: garmentNoun(phrase), colors: [...new Set([...phrase.matchAll(COLOR_RE)].map((c) => normalizeColor(c[1]!)))] }))
        .filter((g) => g.noun),
    );
}

// Parts a proposal often leaves out because the crop hides them; head carries accessories (collars, hats) that matter.
const OPTIONAL_PARTS = new Set<OutfitPart>(["legs", "feet"]);

// "dark"/"light" next to a hue only shades it ("dark gray boxers" are gray, not any dark color).
const hues = (colors: string[]) => (colors.some((c) => c !== "dark" && c !== "light") ? colors.filter((c) => c !== "dark" && c !== "light") : colors);

/**
 * True when `proposal` describes the same outfit as `registered`, only worded differently: every part names the same
 * garments (by noun) in compatible colors, legwear and footwear do not conflict, and the proposal adds no part the
 * registered outfit lacks. It may leave out legs or feet (the registered outfit then completes them). A changed
 * garment, color or added or dropped part is a new outfit.
 */
export function sameOutfit(registered: OutfitParts, proposal: OutfitParts): boolean {
  let shared = 0;
  for (const part of OUTFIT_PARTS) {
    const a = partGarments(registered[part]);
    const b = partGarments(proposal[part]);
    if (!b.length) {
      if (a.length && !OPTIONAL_PARTS.has(part)) return false;
      continue;
    }
    if (!a.length) return false;
    const nouns = (list: typeof a) => [...new Set(list.map((g) => g.noun))].sort().join("|");
    if (nouns(a) !== nouns(b)) return false;
    for (const g of b) if (!a.some((r) => r.noun === g.noun && colorsCompatible(hues(r.colors), hues(g.colors)))) return false;
    if (part === "legs" || part === "feet") {
      const reg = registeredGarments(registered[part], part);
      if (registeredGarments(proposal[part], part).some((m) => reg.length && reg.every((r) => garmentsConflict(r, m)))) return false;
    }
    shared += 1;
  }
  return shared > 0;
}
