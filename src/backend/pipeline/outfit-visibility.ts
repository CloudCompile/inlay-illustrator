/**
 * Outfit visibility and state repair of composed image requests (Inlay addition; deviates from AM 0.9.89).
 *
 * AM weights each outfit part by the chosen crop (`modifierLibrary.weights.body_part`: cowboy_shot drops feet,
 * upper_body drops legs and feet, ...). The crop is often generic while the actor's own text is about legs or feet
 * ("legs up", "bare heels against his collarbone", "target#sucking toes"), so the image model draws legs and feet with
 * no legwear/footwear tags and improvises socks, stockings or bare feet from image to image. AM also has no state for
 * removed shoes or socks, and the analyzer's natural language may name legwear the outfit does not have.
 *
 * `repairBatchItems` runs on the executor's items (engine option `prepareBatchItems`), per character prompt:
 *  - visibility: legwear/footwear parts are restored at full weight when the actor's tags or natural language show
 *    legs or feet (never against an explicit `feet out of frame`, a portrait crop or a focus on another body part);
 *  - state: "barefoot" / "no shoes" / "bare legs" in the actor's text remove the covered parts and add the tag;
 *  - consistency: natural-language legwear/footwear that contradicts the registered part is rewritten to it.
 * The outfit span is parsed from `promptSegments.outfits`; anything that does not parse is left as it is.
 */
import type { RunOutfitIndex } from "./outfit-awareness.js";
import {
  garmentsConflict,
  garmentsIn,
  isAbsencePart,
  legwearCoversFeet,
  registeredGarments,
  type GarmentSlot,
  type OutfitPart,
  type OutfitParts,
  OUTFIT_PARTS,
} from "./outfit-garments.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

export interface Span {
  start: number;
  end: number;
}

interface SegmentEntry {
  part: OutfitPart;
  text: string;
  weight: number;
}

const WEIGHT_PREFIX = /^(-?\d+(?:\.\d+)?)::/;

/** Weighted or plain `chunk` at `pos`, followed by ", " or the end: [weight, end] or null. */
function chunkAt(segment: string, pos: number, chunk: string): [number, number] | null {
  const done = (end: number) => end === segment.length || segment.startsWith(", ", end);
  if (segment.startsWith(chunk, pos) && done(pos + chunk.length)) return [1, pos + chunk.length];
  const w = WEIGHT_PREFIX.exec(segment.slice(pos));
  if (w && segment.startsWith(`${chunk}::`, pos + w[0].length)) {
    const end = pos + w[0].length + chunk.length + 2;
    if (done(end)) return [Number(w[1]), end];
  }
  return null;
}

/** A part at `pos`: its whole text (plain or `w::text::`), or each comma chunk weighted alike (`w::a::, w::b::`). */
function partAt(segment: string, pos: number, text: string): [number, number] | null {
  const whole = chunkAt(segment, pos, text);
  if (whole) return whole;
  const chunks = text.split(",").map((c) => c.trim()).filter(Boolean);
  if (chunks.length < 2) return null;
  let at = pos;
  let weight = 0;
  for (const [i, c] of chunks.entries()) {
    const hit = chunkAt(segment, at, c);
    if (!hit || (i > 0 && hit[0] !== weight)) return null;
    weight = hit[0];
    at = hit[1] + (i < chunks.length - 1 ? 2 : 0);
  }
  return [weight, at];
}

/**
 * Splits an outfit span into its parts (in `parts` order; a part is rendered plain, `w::text::`, or per comma chunk
 * `w::a::, w::b::` as the V5 compiler weights tags); parts the crop dropped are skipped. Null when it does not parse.
 */
export function parseOutfitSegment(segment: string, parts: OutfitParts): SegmentEntry[] | null {
  const expected = OUTFIT_PARTS.flatMap((part) => (parts[part]?.trim() ? [{ part, text: parts[part]!.trim() }] : []));
  const out: SegmentEntry[] = [];
  let pos = 0;
  let next = 0;
  while (pos < segment.length) {
    let matched = false;
    for (let i = next; i < expected.length && !matched; i += 1) {
      const { part, text } = expected[i]!;
      const hit = partAt(segment, pos, text);
      if (!hit) continue;
      out.push({ part, text, weight: hit[0] });
      pos = hit[1];
      matched = true;
      next = i + 1;
    }
    if (!matched) return null;
    if (pos < segment.length) pos += 2;
  }
  return out;
}

const formatWeight = (w: number) => (Number.isInteger(w) ? String(w) : String(Number(w.toFixed(4))));
/** A part as the V5 compiler renders it: weight 1 plain, otherwise each comma chunk weighted. */
const renderEntry = (e: SegmentEntry) =>
  e.weight === 1
    ? e.text
    : e.text
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => `${formatWeight(e.weight)}::${c}::`)
        .join(", ");

// Body-type tags that mention legs without showing them.
const BODY_TYPE_TAG = /(^|, )(?:-?\d+(?:\.\d+)?::)?(?:thick|long|slender|skinny|muscular|plump|toned|thin|wide|curvy|shapely) (?:thighs|legs|hips)(?:::)?(?=,|$)/gi;

const FOREIGN_PRONOUNS: Record<string, RegExp> = {
  female: /\b(?:his|him|he)\b/i,
  male: /\b(?:her|hers|she)\b/i,
};

function genderOf(tags: string): "female" | "male" | "" {
  const first = tags.split(",")[0]?.trim().toLowerCase() ?? "";
  return first === "female" || first === "girl" || first === "1girl" ? "female" : first === "male" || first === "boy" || first === "1boy" ? "male" : "";
}

/** True when the words just before `index` make the phrase someone else's ("his socks" in a female actor's prompt) or negate it. */
function foreignOrNegated(text: string, index: number, gender: string): boolean {
  const before = text.slice(Math.max(0, index - 40), index).split(/[.;!?\n]/).at(-1) ?? "";
  const words = before.trim().split(/\s+/).slice(-3).join(" ");
  if (/\b(?:not|no longer|never)\b/i.test(words)) return true;
  if (/\b\w+'s\s*(?:\w+\s*){0,2}$/i.test(words) && !/\b(?:her|his|their|its)\b/i.test(words.split(/\s+/).at(-1) ?? "")) return true;
  const foreign = FOREIGN_PRONOUNS[gender];
  return !!foreign && foreign.test(words);
}

function matchesOwn(text: string, re: RegExp, gender: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) if (!foreignOrNegated(text, m.index ?? 0, gender)) return true;
  return false;
}

const OWN_PRONOUNS: Record<string, RegExp> = { female: /\bher\b/i, male: /\bhis\b/i, "": /\b(?:her|his|their)\b/i };

/**
 * Like `matchesOwn`, for noun phrases that are as often another actor's ("staring at the dangling bare feet" in the
 * other actor's prompt): only counts with the actor's own possessive or a wearing construct just before
 * ("her bare feet", "with bare feet", "in socked feet").
 */
function matchesOwnNoun(text: string, re: RegExp, gender: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    const index = m.index ?? 0;
    if (foreignOrNegated(text, index, gender)) continue;
    const words = (text.slice(Math.max(0, index - 40), index).split(/[.;!?\n]/).at(-1) ?? "").trim().split(/\s+/).slice(-3).join(" ");
    if (OWN_PRONOUNS[gender]!.test(words) || /\b(?:with|in|on)\b/i.test(words)) return true;
  }
  return false;
}

// States the actor's own text gives. *_STATE phrases describe the subject; *_NOUN phrases need an owner (matchesOwnNoun).
const BAREFOOT_STATE = /\b(?:barefoot(?:ed)?|bare-footed|(?:lower )?legs and feet (?:are )?bare|feet (?:are )?bare)\b/i;
const BAREFOOT_NOUN = /\bbare[- ](?:feet|foot|soles?|toes|heels?)\b|\bbare legs and feet\b/i;
const NO_SHOES_STATE =
  /\b(?:no shoes|shoeless|shoes (?:off|removed|kicked off)|without (?:her |his |their )?(?:shoes|footwear)|(?:kick(?:s|ed|ing)?|t(?:ook|akes|aking)|slip(?:s|ped|ping)|pull(?:s|ed|ing)) off (?:her |his |their )?(?:shoes|loafers|sneakers|boots|heels|slippers|footwear))\b/i;
const NO_SHOES_NOUN = /\b(?:(?:[a-z]+-)?socked (?:feet|foot|soles?|toes)|stocking(?:ed)? (?:feet|foot|soles?|toes)|socks without shoes)\b/i;
const BARE_LEGS_STATE =
  /\b(?:bare-legged|legs (?:are )?bare|no (?:socks|stockings|legwear|tights|pantyhose)|sockless|without (?:her |his |their )?(?:socks|stockings|tights|pantyhose|legwear)|(?:t(?:ook|akes|aking)|peel(?:s|ed|ing)|roll(?:s|ed|ing)|pull(?:s|ed|ing)|slip(?:s|ped|ping)) off (?:her |his |their )?(?:socks|stockings|thighhighs|thigh-highs|tights|pantyhose|kneehighs|knee-highs|legwear))\b/i;
const BARE_LEGS_NOUN = /\bbare legs\b(?! and feet)/i;
const LEGS_AND_FEET_BARE = /\b(?:(?:lower )?legs and feet (?:are )?bare)\b/i;

const FEET_CUE =
  /\b(?:feet|foot|toes?|soles?|ankles?|heels?|insteps?|barefoot|footwear|shoes?|loafers?|sneakers?|boots?|sandals?|slippers?|uwabaki|tiptoes?|kick(?:s|ed|ing)?|stomp(?:s|ed|ing)?|step(?:s|ped|ping) on|footjob|foot focus|feet up|full body|standing on one leg)\b/i;
const LEGS_CUE =
  /\b(?:legs?|knees?|kneel(?:s|ing)?|kneehighs?|knee-highs?|shins?|calf|calves|squat(?:s|ting)?|crouch(?:es|ing)?|straddl(?:e|es|ed|ing)|socks?|stockings?|legwear|crossed legs|legs crossed|spread legs|legs apart|legs up|knees up|knees to chest|leg lift|full body)\b/i;
const THIGH_CUE = /\b(?:thighs?|zettai ryouiki|absolute territory|thighhighs?|thigh-highs?|pantyhose|tights|leggings|lap pillow)\b/i;
const LONG_LEGWEAR = new Set(["thighhighs", "stockings", "pantyhose", "leggings"]);
// Interaction tags: `source#X` is what the actor does to someone else ("source#wiping foot"), `target#X` what someone
// else does to the actor ("target#footjob": the other actor's feet). Each counts as a cue for the actor's own legs and
// feet only when the action uses them: done with the actor's feet as source, or done to them as target.
const SOURCE_TAG = /^\s*(?:-?\d+(?:\.\d+)?::)?source#/i;
const TARGET_TAG = /^\s*(?:-?\d+(?:\.\d+)?::)?target#/i;
const OWN_FOOT_ACTION =
  /footjob|\bby (?:her |his |their )?(?:foot|feet)\b|\bwith (?:her |his |their )?(?:foot|feet|soles|toes)\b|between (?:her |his |their )?(?:feet|soles)\b|\bkick|\bstep(?:s|ping)? on\b|\bstomp|\btrampl|\b(?:feet|foot) on\b/i;
const OWN_FOOT_RECEIVED =
  /\b(?:(?:sucking|licking|kissing|biting|nibbling|tickling|massaging|smelling|sniffing|holding|grabbing|gripping|worshipping|wiping|washing) (?:feet|foot|toes?|soles?|ankles?|legs?|knees?|thighs?)|(?:foot|feet|toe|sole|leg|thigh) (?:worship|licking|sucking|kiss|massage|sniffing|smelling|tickling|grab|lift)|ankle grab|leg (?:hold|lock))\b/i;
const interactionCue = (tag: string): boolean =>
  SOURCE_TAG.test(tag) ? OWN_FOOT_ACTION.test(tag) : TARGET_TAG.test(tag) ? OWN_FOOT_RECEIVED.test(tag) : true;

// A body part the actor handles ("holding both ankles", "gathering both bare ankles against his shoulder", "lips pressed
// against bare soles") is the other actor's unless the actor's own pronoun is attached to it. Pressing and spreading
// are left out: they mostly move the actor's own limbs ("pressing boot tread against his chest", "spread boots").
const HANDLED_BY =
  /\b(?:hold(?:s|ing)?|held|grip(?:s|ping|ped)?|grab(?:s|bing|bed)?|gather(?:s|ing|ed)?|cradl(?:e|es|ing|ed)|clutch(?:es|ing|ed)?|cup(?:s|ping|ped)?|kiss(?:es|ing|ed)?|lick(?:s|ing|ed)?|suck(?:s|ing|ed)?|nibbl\w*|bit(?:es?|ing)|massag\w*|knead\w*|rub(?:s|bing|bed)?|strok\w*|caress\w*|tickl\w*|touch(?:es|ing|ed)?|squeez\w*|lift(?:s|ing|ed)?|pin(?:s|ning|ned)?|wip(?:e|es|ing|ed)|wash(?:es|ing|ed)?|worship\w*|sniff\w*|smell\w*|wrap\w*|around|against|between)\b/i;

// Feet shown bare by what they do: a footjob, soles or toes on show, toes sucked. Footwear does not come back for these
// (the actor's legwear does) unless the actor's text names worn footwear.
const FOOTWEAR_OFF_CUE =
  /\b(?:footjob|(?<!(?:shoe|boot|sneaker|loafer|slipper|sandal|heel) )soles?|(?<!tip)toes|toe (?:sucking|licking|curl\w*)|(?:sucking|licking|kissing|curl(?:s|ing|ed)?|spread(?:s|ing)?|wiggl\w*) (?:her |his |their )?(?:big )?toes?|(?:foot|feet) (?:worship|licking|massage|sniffing|smelling|on face)|feet on (?:his|her|their) face)\b/i;

/**
 * Visibility cue owned by the actor: `matchesOwn`, and a body part introduced by "the" without the actor's own pronoun
 * ("wiping the damp bare foot" in the other actor's prompt) is someone else's.
 */
function matchesOwnCue(text: string, re: RegExp, gender: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) {
    const index = m.index ?? 0;
    if (foreignOrNegated(text, index, gender)) continue;
    const clause = (text.slice(Math.max(0, index - 80), index).split(/[.;!?\n,]/).at(-1) ?? "").trim().split(/\s+/);
    const near = clause.slice(-3).join(" ");
    if (OWN_PRONOUNS[gender]!.test(near)) return true;
    if (/\bthe\b/i.test(near) || HANDLED_BY.test(clause.slice(-8).join(" "))) continue;
    return true;
  }
  return false;
}

// "foot"/"feet" as a unit or a place, not a body part: "six-foot height", "three feet from the bed", "the foot of the bed".
const NOT_A_FOOT =
  /\b(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|few|several|a couple of|many)[- ](?:foot|feet)\b|\b(?:feet|foot) (?:away|tall|high|long|wide|deep|apart from)\b|\bfoot of (?:the|a|an|her|his|their|its) |\bon foot\b|\bfoot traffic\b/gi;

// Crops and focuses that deliberately keep legs and feet out of the image.
const BLOCKING_TAGS = ["portrait", "hand focus", "eye focus", "breast focus", "pectoral focus", "crotch focus", "ass focus", "hip focus", "face focus"];

export interface ActorRepairInput {
  prompt: string;
  segment?: Span;
  parts?: OutfitParts;
  /** `promptPlan.selectedFraming` (crop option id, e.g. "cowboy_shot"). */
  framing?: string;
  globalPositive?: string;
}

export interface ActorRepair {
  prompt: string;
  segment?: Span;
  changes: string[];
}

function hasTag(tags: string, tag: string): boolean {
  return new RegExp(String.raw`(^|,\s*)(?:-?\d+(?:\.\d+)?::)?${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:::)?\s*(?=,|$)`, "i").test(tags);
}

/** One character prompt repaired; null when nothing applies (unknown outfit, unparsable span, nude outfit). */
export function repairActorPrompt(input: ActorRepairInput): ActorRepair | null {
  const { prompt, segment, parts } = input;
  if (!parts || /\bcompletely nude\b/i.test(parts.top ?? "")) return null;
  const nlStart = prompt.indexOf("\n");
  const tagsEnd = nlStart < 0 ? prompt.length : nlStart;
  const tags = prompt.slice(0, tagsEnd);
  let nl = nlStart < 0 ? "" : prompt.slice(nlStart + 1);
  const seg = segment && segment.start >= 0 && segment.end <= tagsEnd && segment.start < segment.end ? segment : undefined;
  const entries = seg ? parseOutfitSegment(prompt.slice(seg.start, seg.end), parts) : null;
  const before = seg ? tags.slice(0, seg.start) : tags;
  const after = seg ? tags.slice(seg.end) : "";
  const otherTags = `${before}${after}`.replace(BODY_TYPE_TAG, "$1");
  const gender = genderOf(tags);
  const cueText = `${otherTags}\n${nl}`;
  const changes: string[] = [];

  // State from the actor's own text: its free tags, or natural language about the actor itself.
  const legsAndFeetBare = matchesOwn(nl, LEGS_AND_FEET_BARE, gender);
  const barefoot =
    legsAndFeetBare || hasTag(otherTags, "barefoot") || matchesOwn(nl, BAREFOOT_STATE, gender) || matchesOwnNoun(nl, BAREFOOT_NOUN, gender);
  const noShoes = !barefoot && (hasTag(otherTags, "no shoes") || matchesOwn(nl, NO_SHOES_STATE, gender) || matchesOwnNoun(nl, NO_SHOES_NOUN, gender));
  const bareLegs =
    legsAndFeetBare ||
    ["bare legs", "no socks", "no legwear"].some((t) => hasTag(otherTags, t)) ||
    matchesOwn(nl, BARE_LEGS_STATE, gender) ||
    matchesOwnNoun(nl, BARE_LEGS_NOUN, gender);
  // Worn legwear/footwear the actor's own text names (not someone else's).
  const named = (slot: GarmentSlot) => garmentsIn(cueText, slot).some((m) => !foreignOrNegated(cueText, m.start, gender));

  const removed = new Set<OutfitPart>();
  const removedWhy = new Map<OutfitPart, string>();
  const remove = (p: OutfitPart, why: string) => {
    removed.add(p);
    removedWhy.set(p, why);
  };
  // "No shoes" keeps a feet part that registers socks only ("black dress socks").
  if (parts.feet && !isAbsencePart(parts.feet) && (barefoot || (noShoes && registeredGarments(parts.feet, "feet").length))) remove("feet", barefoot ? "barefoot" : "no shoes");
  if (bareLegs && parts.legs && !isAbsencePart(parts.legs)) remove("legs", "bare legs");
  else if (barefoot && legwearCoversFeet(parts.legs)) remove("legs", "barefoot");
  // An absence part ("bare legs", "barefoot") is no garment; it goes when the actor's text puts something on that body part.
  if (parts.legs && isAbsencePart(parts.legs) && !bareLegs && !barefoot && named("legs")) remove("legs", "the text names legwear");
  if (parts.feet && isAbsencePart(parts.feet) && !barefoot && (noShoes || named("feet") || named("legs"))) remove("feet", noShoes ? "no shoes" : "the text names footwear or socks");

  // Visibility from the actor's own text and the crop.
  const blocked = input.framing === "portrait" || BLOCKING_TAGS.some((t) => hasTag(otherTags, t));
  const feetOut = input.framing === "feet_out_of_frame" || /(^|,\s*)feet out of frame\s*(?=,|$)/i.test(input.globalPositive ?? "") || hasTag(otherTags, "feet out of frame");
  const cueTags = otherTags.split(",").filter(interactionCue).join(",").replace(NOT_A_FOOT, " ");
  const cueNl = nl.replace(NOT_A_FOOT, " ");
  // The actor's tags are its own; its natural language also describes the other actor's body.
  const cue = (re: RegExp) => re.test(cueTags) || matchesOwnCue(cueNl, re, gender);
  const feetVisible = !blocked && !feetOut && cue(FEET_CUE);
  const footwearOff = feetVisible && cue(FOOTWEAR_OFF_CUE) && !named("feet");
  const longLegwear = registeredGarments(parts.legs, "legs").some((g) => LONG_LEGWEAR.has(g.family));
  const legsVisible = !blocked && (feetVisible || cue(LEGS_CUE) || (longLegwear && cue(THIGH_CUE)));

  let nextEntries = entries;
  if (entries) {
    const byPart = new Map(entries.map((e) => [e.part, e]));
    const want = new Map<OutfitPart, number>(entries.map((e) => [e.part, e.weight]));
    for (const p of removed) {
      if (want.has(p)) changes.push(`${p}: removed (${removedWhy.get(p)})`);
      want.delete(p);
    }
    // Absence parts are never restored: they are not garments, and the crop dropped them for a reason.
    const raise = (p: OutfitPart, visible: boolean) => {
      if (!visible || removed.has(p) || !parts[p]?.trim() || isAbsencePart(parts[p])) return;
      const current = want.get(p) ?? 0;
      if (current >= 1) return;
      want.set(p, 1);
      changes.push(`${p}: ${current ? `weight ${current}` : "dropped"} -> 1 (${p === "feet" ? "feet" : "legs"} visible)`);
    };
    raise("legs", legsVisible);
    raise("feet", feetVisible && !footwearOff);
    // A skirt or shorts already in the prompt at a reduced weight follows visible legs; a dropped bottom stays dropped
    // (it may be a `bottomless` state).
    if (legsVisible && byPart.has("bottom") && (want.get("bottom") ?? 1) < 1 && !removed.has("bottom")) {
      changes.push(`bottom: weight ${want.get("bottom")} -> 1 (legs visible)`);
      want.set("bottom", 1);
    }
    nextEntries = OUTFIT_PARTS.flatMap((p) => (want.has(p) ? [{ part: p, text: byPart.get(p)?.text ?? parts[p]!.trim(), weight: want.get(p)! }] : []));
  }

  // State tags the image model needs next to the outfit.
  const stateTags: string[] = [];
  const tagLine = `${otherTags}, ${entries?.map(renderEntry).join(", ") ?? ""}`;
  if (barefoot && !hasTag(tagLine, "barefoot")) stateTags.push("barefoot");
  if (noShoes && !hasTag(tagLine, "no shoes")) stateTags.push("no shoes");
  if (bareLegs && !barefoot && removedWhy.get("legs") === "bare legs" && !hasTag(tagLine, "bare legs")) stateTags.push("bare legs");
  if (stateTags.length) changes.push(`state: + ${stateTags.join(", ")}`);

  // Natural language that names other legwear than the registered part. Footwear is left alone: its mentions are too
  // often objects or another actor's ("reaching for indoor slippers", "pinned under a boot sole").
  for (const slot of ["legs"] as GarmentSlot[]) {
    if (removed.has(slot)) continue;
    const registered = registeredGarments(parts[slot], slot);
    if (!registered.length) continue;
    const mentions = garmentsIn(nl, slot).filter((m) => !foreignOrNegated(nl, m.start, gender));
    let rewritten = "";
    let cursor = 0;
    let replaced = false;
    for (const m of mentions) {
      if (!registered.every((r) => garmentsConflict(r, m))) continue;
      rewritten += nl.slice(cursor, m.start) + registered[0]!.chunk;
      cursor = m.end;
      replaced = true;
      changes.push(`nl: "${m.text}" -> "${registered[0]!.chunk}"`);
    }
    if (replaced) nl = rewritten + nl.slice(cursor);
  }

  if (!changes.length) return null;

  let newTags = tags;
  let newSegment = seg;
  if (seg && nextEntries) {
    // State tags go right after the outfit span, outside it: the span keeps covering outfit parts only.
    const outfit = nextEntries.map(renderEntry).join(", ");
    const rendered = [outfit, ...stateTags].filter(Boolean).join(", ");
    if (rendered) {
      newTags = before + rendered + after;
      newSegment = outfit ? { start: seg.start, end: seg.start + outfit.length } : undefined;
    } else {
      newTags = (before.replace(/,\s*$/, "") + (before.trim() && after ? after : after.replace(/^,\s*/, ""))).replace(/^,\s*/, "");
      newSegment = undefined;
    }
  } else if (stateTags.length) {
    newTags = tags ? `${tags}, ${stateTags.join(", ")}` : stateTags.join(", ");
  }
  const newPrompt = nlStart < 0 ? newTags : `${newTags}\n${nl}`;
  if (newPrompt === prompt) return null;
  return { prompt: newPrompt, ...(newSegment ? { segment: newSegment } : {}), changes };
}

/** Deep copy of plain objects/arrays with every occurrence of each `[from, to]` replaced in string values. */
export function replaceInStrings<T>(value: T, replacements: ReadonlyArray<readonly [string, string]>): T {
  if (!replacements.length) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return replacements.reduce((s, [from, to]) => (s.includes(from) ? s.split(from).join(to) : s), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v as Rec).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export interface BatchRepairLog {
  sourceImageToken: string;
  actorId: string;
  changes: string[];
}

/**
 * Items of one executor call with repaired character prompts. Items without a known outfit or without changes are
 * returned as they are; repaired items keep every field and reference except `promptPlan`, `promptSegments` and the
 * two prompt closures, whose results get the repaired prompts.
 */
export function repairBatchItems<T>(items: readonly T[], index: RunOutfitIndex | undefined, onRepair?: (log: BatchRepairLog) => void): T[] {
  if (!index) return [...items];
  return items.map((item) => {
    const it = rec(item);
    const plan = rec(it.promptPlan);
    const characters = arr(plan.characters).map(rec);
    if (!characters.length) return item;
    const segments = rec(it.promptSegments);
    const outfits = { ...rec(segments.outfits) };
    const actors = arr(it.actors).map(rec);
    const replacements: Array<[string, string]> = [];
    const nextCharacters = characters.map((c, i) => {
      const actor = actors.find((a) => Number(a.actorIndex) === i) ?? actors[i] ?? {};
      const parts = index.parts(str(actor.identityKey) || str(c.identityKey), str(actor.selectedFormId), str(actor.selectedOutfitId) || str(c.selectedOutfitId));
      const key = `actor_${i + 1}`;
      const span = rec(outfits[key]);
      const segment = Number.isInteger(span.start) && Number.isInteger(span.end) ? { start: Number(span.start), end: Number(span.end) } : undefined;
      const prompt = str(c.prompt);
      const repair = prompt ? repairActorPrompt({ prompt, segment, parts, framing: str(plan.selectedFraming), globalPositive: str(plan.globalPositive) }) : null;
      if (!repair) return c;
      replacements.push([prompt, repair.prompt]);
      if (repair.segment) outfits[key] = Object.freeze({ ...repair.segment });
      else delete outfits[key];
      onRepair?.({ sourceImageToken: str(it.sourceImageToken), actorId: str(actor.actorId) || key, changes: repair.changes });
      return Object.freeze({ ...c, prompt: repair.prompt });
    });
    if (!replacements.length) return item;
    const createNovelAIConfig = it.createNovelAIConfig as ((seed: unknown) => unknown) | undefined;
    const prepareProviderPrompt = it.prepareProviderPrompt as ((ctx: unknown) => unknown) | undefined;
    return {
      ...it,
      promptPlan: Object.freeze({ ...plan, characters: Object.freeze(nextCharacters) }),
      promptSegments: Object.freeze({ ...segments, outfits: Object.freeze(outfits) }),
      ...(createNovelAIConfig ? { createNovelAIConfig: (seed: unknown) => replaceInStrings(createNovelAIConfig(seed), replacements) } : {}),
      ...(prepareProviderPrompt ? { prepareProviderPrompt: (ctx: unknown) => replaceInStrings(prepareProviderPrompt(ctx), replacements) } : {}),
    } as T;
  });
}
