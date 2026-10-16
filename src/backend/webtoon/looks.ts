/**
 * Looks the planner writes (webtoon / manga): characters without an analysed appearance get identity + outfit tags from the
 * planner (from the card's appearance text), code injects them into every panel like analysed identities. The look is kept on
 * the strip's cast (`look`) and the latest strip's look is the fixed look of later strips (an analysis always wins).
 * With free character generation on, the planner may also add story characters who are in no roster (strangers); they are
 * persisted through the same autoCharacter path as normal mode (see run.ts).
 */
import type { StorageService } from "../services/types.js";
import type { OutfitPart } from "./panel-request.js";
import type { PlannerRosterEntry } from "./planner-prompt.js";
import type { RosterCharacter } from "./roster.js";
import { readStrip, stripSummaries } from "./store.js";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const PARTS: readonly OutfitPart[] = ["head", "top", "bottom", "legs", "feet"];
export const fold = (s: string) => s.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, " ");

/** A look written by the planner, stored on the strip's cast entry. Identity keeps its colours (manga strips colour only the prompts). */
export interface DerivedLook {
  identity: string;
  outfitLabel: string;
  outfit: Partial<Record<OutfitPart, string>>;
}

/** Explicit anatomy / nudity: left out of the appearance text and of the planner's tags (keeps the planner call clear of safety stops). */
const EXPLICIT = /genital|pubic|labia|vagin|vulva|penis|nipple|areola|breast|\bbust\b|\b[a-k][- ]?cup\b|\banus\b|clitor|testic|\bnude\b|naked|\bbra\b|panties|lingerie|underwear|\bnsfw\b|\bsex/iu;
const APPEARANCE_HEADING = /^\s*(?:#{1,6}\s*|\[|<|\*\*)?\s*(?:appearance|looks?|physical(?: description| appearance| traits)?|visual(?: description)?|외모|외형|外見|外貌)\b/iu;
const HEADING = /^\s*(?:#{1,6}\s+\S|\[[^\]]+\]\s*$|<\/?[\p{L}_ -]+>\s*$|\*\*[^*]+\*\*:?\s*$|[\p{L}][\p{L} &/-]{1,40}:\s*$)/u;
export const APPEARANCE_MAX = 2000;

/**
 * Appearance text of a card / persona description: an Appearance-like section when there is one, else the start of the
 * description; lines with explicit anatomy dropped; `{{char}}` / `{{user}}` filled in; capped at about APPEARANCE_MAX chars.
 */
export function appearanceText(description: string, vars: { char: string; user: string }): string {
  const lines = description
    .replace(/\{\{\s*char\s*\}\}/giu, vars.char)
    .replace(/\{\{\s*user\s*\}\}/giu, vars.user)
    .replace(/\{\{[^}]*\}\}/gu, "")
    .split(/\r?\n/u);
  const start = lines.findIndex((l) => APPEARANCE_HEADING.test(l));
  let section = lines;
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && HEADING.test(l) && !APPEARANCE_HEADING.test(l));
    const body = lines.slice(start, end < 0 ? undefined : end);
    if (body.slice(1).some((l) => l.trim()) || /:\s*\S/u.test(body[0]!)) section = body;
  }
  let out = "";
  for (const line of section.filter((l) => !EXPLICIT.test(l))) {
    if (out.length + line.length + 1 > APPEARANCE_MAX) {
      if (!out) out = line.slice(0, APPEARANCE_MAX);
      break;
    }
    out += (out ? "\n" : "") + line;
  }
  return out.replace(/\n{3,}/gu, "\n\n").trim();
}

/** NovelAI tag shape (AM appearance-tag rule `t8e`): lowercase, letters / digits / spaces / ()'!.- only. */
const TAG = /^[\p{Ll}\p{Lo}0-9][\p{Ll}\p{Lo}0-9 ()'!.-]{0,39}$/u;
const COUNT = /^(?:\d+\s*(?:girls?|boys?|others?)|solo|multiple (?:girls|boys))$/u;
const GENDER_WORD = /^(?:female|male|girl|boy|woman|man|other)$/u;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Comma tags of the planner, cleaned: tag-like, no count / explicit tags, no names of `names`, deduped, at most `max`. */
export function cleanTags(value: unknown, names: readonly string[], max: number): string[] {
  const banned = names.filter((n) => n.trim().length > 1).map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(fold(n))}(?![\\p{L}\\p{N}])`, "u"));
  const seen = new Set<string>();
  return str(value)
    .split(/[,\n]/u)
    .map((t) => t.replace(/[{}[\]]|::/gu, " ").replace(/_/gu, " ").replace(/\s+/gu, " ").trim().toLocaleLowerCase())
    .filter((t) => TAG.test(t) && t.split(" ").length <= 5 && !COUNT.test(t) && !EXPLICIT.test(t) && !banned.some((b) => b.test(t)) && !seen.has(t) && (seen.add(t), true))
    .slice(0, max);
}

interface PlannerLook {
  name: string;
  gender: string;
  identity: string[];
  outfitLabel: string;
  outfit: Partial<Record<OutfitPart, string>>;
}

/** One "looks" item, validated; null when unusable. `identity` empty = an outfit only (characters with a fixed look). */
function parseLook(value: unknown, otherNames: readonly string[]): PlannerLook | null {
  const v = rec(value);
  const name = str(v.name);
  if (!name) return null;
  const tags = cleanTags(v.identity, otherNames, 16);
  const genderTag = tags.find((t) => t === "female" || t === "male");
  const g = str(v.gender).toLowerCase();
  const gender = g === "female" || g === "male" ? g : (genderTag ?? (g ? "other" : ""));
  const o = rec(v.outfit);
  const outfit: PlannerLook["outfit"] = {};
  for (const part of PARTS) {
    const t = cleanTags(o[part], otherNames, 6);
    if (t.length) outfit[part] = t.join(", ");
  }
  return { name, gender, identity: tags.filter((t) => !GENDER_WORD.test(t)), outfitLabel: str(o.label ?? o.name).slice(0, 60), outfit };
}

const identityOf = (gender: string, tags: readonly string[]) => [gender === "female" || gender === "male" ? gender : "", ...tags].filter(Boolean).join(", ");
const hasOutfit = (o: PlannerLook["outfit"]) => PARTS.some((p) => o[p]);

export interface ResolvedLooks {
  /** Roster with the planner's looks applied (characters left without a look are dropped). */
  roster: RosterCharacter[];
  /** Name -> outfit written in "looks" (replaces the planner's wardrobe pick). */
  outfits: Record<string, string>;
  /** Story characters in no roster (free character generation on): drawn in this strip and persisted by the run. */
  strangers: Array<RosterCharacter & { identityTags: string[] }>;
  /** Key -> look kept on the strip's cast. */
  looks: Map<string, DerivedLook>;
  log: string[];
}

/**
 * Applies the planner's "looks": a look for each roster character without a design, a new outfit for a character with a
 * look from an earlier strip, and (`known` given = free character generation on) new story characters, never one whose name
 * matches a known identity.
 */
export function resolveLooks(raw: unknown, roster: readonly RosterCharacter[], known: readonly string[] | null): ResolvedLooks {
  const log: string[] = [];
  const list = Array.isArray(rec(raw).looks) ? (rec(raw).looks as unknown[]) : [];
  const allNames = roster.map((r) => r.name);
  const byName = new Map<string, PlannerLook>();
  for (const item of list) {
    const name = str(rec(item).name);
    const look = parseLook(item, allNames.filter((n) => fold(n) !== fold(name)));
    if (look && !byName.has(fold(look.name))) byName.set(fold(look.name), look);
  }
  const out: RosterCharacter[] = [];
  const outfits: Record<string, string> = {};
  const looks = new Map<string, DerivedLook>();
  for (const r of roster) {
    const look = byName.get(fold(r.name));
    byName.delete(fold(r.name));
    if (r.appearance !== undefined) {
      if (!look?.identity.length) {
        log.push(`${r.name}: no look written, left out of the cast`);
        continue;
      }
      const outfit = hasOutfit(look.outfit) ? [{ id: "look_1", label: look.outfitLabel || "outfit", outfit: look.outfit }] : [];
      const gender = look.gender || r.gender;
      const designed: RosterCharacter = { ...r, gender, identity: identityOf(gender, look.identity), outfits: outfit, currentOutfitId: outfit[0]?.id ?? "" };
      delete designed.appearance;
      out.push(designed);
      if (designed.currentOutfitId) outfits[r.name] = designed.currentOutfitId;
      looks.set(r.key, { identity: designed.identity, outfitLabel: outfit[0]?.label ?? "", outfit: outfit[0]?.outfit ?? {} });
      continue;
    }
    if (r.designed) {
      let next = r;
      if (look && hasOutfit(look.outfit)) {
        const id = `look_${Math.max(0, ...r.outfits.map((o) => Number(/^look_(\d+)$/u.exec(o.id)?.[1] ?? 0))) + 1}`;
        next = { ...r, outfits: [...r.outfits, { id, label: look.outfitLabel || "outfit", outfit: look.outfit }], currentOutfitId: id };
        outfits[r.name] = id;
      }
      const o = next.outfits.find((x) => x.id === next.currentOutfitId);
      looks.set(r.key, { identity: r.identity, outfitLabel: o?.label ?? "", outfit: o?.outfit ?? {} });
      out.push(next);
      continue;
    }
    out.push(r);
  }
  const strangers: ResolvedLooks["strangers"] = [];
  const knownSet = new Set((known ?? []).map(fold));
  for (const look of byName.values()) {
    if (!known) log.push(`${look.name}: not in the roster, free character generation is off`);
    else if (knownSet.has(fold(look.name))) log.push(`${look.name}: a known character, not created again`);
    else if (!look.identity.length || !hasOutfit(look.outfit)) log.push(`${look.name}: incomplete look, left out`);
    else {
      const id = "look_1";
      strangers.push({
        key: `free::${fold(look.name)}`,
        name: look.name,
        gender: look.gender,
        formLabel: "",
        outfits: [{ id, label: look.outfitLabel || "outfit", outfit: look.outfit }],
        currentOutfitId: id,
        identity: identityOf(look.gender, look.identity),
        identityTags: look.identity,
      });
    }
  }
  return { roster: [...out, ...strangers], outfits, strangers, looks, log };
}

const HAIR_COLOUR_WORD = /\b(?:black|white|red|orange|yellow|green|blue|purple|pink|brown|grey|gray|silver|blonde|blond|platinum|teal|aqua)\b/u;

/** Appearance groups for a free-generated character profile (AM free_character_profile_contract.basePromptGroups). */
export function profileGroups(tags: readonly string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const add = (g: string, t: string) => (groups[g] ??= []).push(t);
  for (const t of tags) {
    if (/^(?:very short|short|medium|long|very long|absurdly long) hair$/u.test(t)) add("hair.length", t);
    else if (/ hair$/u.test(t) && HAIR_COLOUR_WORD.test(t)) add("hair.color", t);
    else if (/hair|bangs|braid|ponytail|twintails|pigtails|bob cut|hime cut|ahoge|bun\b/u.test(t)) add("hair.style", t);
    else if (/eyes?$|pupils|eyelashes/u.test(t)) add("eyes.color", t);
    else if (/skin$|\btan\b|freckles/u.test(t)) add("body.skin", t);
    else if (/^(?:slim|slender|petite|tall|short|muscular|chubby|plump|curvy|stocky|lanky|thin|fat|average height|small|large|athletic|toned)\b/u.test(t)) add("body.build", t);
    else if (/ears|tail|horns|wings|fur|scales|muzzle|snout|fangs|halo|furry|anthro/u.test(t)) add("nonhuman.features", t);
    else add("marks.distinctive", t);
  }
  return groups;
}

/** Looks of the chat's strips, newest strip first per cast key (the fixed look of later strips). */
export async function latestLooks(storage: StorageService, chatId: string): Promise<Map<string, DerivedLook & { gender: string; outfitId: string }>> {
  const docs = [];
  for (const historyId of Object.keys(await stripSummaries(storage, chatId))) {
    const doc = await readStrip(storage, chatId, historyId);
    if (doc?.cast.some((c) => c.look)) docs.push(doc);
  }
  docs.sort((a, b) => b.updatedAt - a.updatedAt);
  const out = new Map<string, DerivedLook & { gender: string; outfitId: string }>();
  for (const doc of docs) for (const c of doc.cast) if (c.look && !out.has(c.key)) out.set(c.key, { ...c.look, gender: c.gender ?? "", outfitId: c.outfitId });
  return out;
}

/** Planner instructions for "looks" (empty when nothing needs one). */
export function looksNote(roster: readonly PlannerRosterEntry[], freeCharacters: boolean): string {
  const undesigned = roster.some((r) => r.appearance !== undefined);
  const designed = roster.some((r) => r.designed);
  const parts: string[] = [];
  if (undesigned || freeCharacters)
    parts.push(
      `Looks (field "looks", next to "outfits"): ${undesigned ? 'for each character marked "no design yet" that you draw' : ""}${undesigned && freeCharacters ? ", and " : ""}${freeCharacters ? "for each person the reply shows who is NOT listed above (a shop manager, a stranger on the train; give them their name from the reply, or a short role name like \"Store Manager\", and use that name everywhere)" : ""}, write their look ONCE: {"name", "gender": "female"|"male"|"other", "identity": "...", "outfit": {"label", "head", "top", "bottom", "legs", "feet"}}.`,
      `- "identity": 5-12 NovelAI/danbooru tags for what never changes, one feature per tag ("long hair, black hair", not "long black hair"): hair colour, hair length and style, bangs, eye colour, skin, height/build (e.g. "slim", "tall"), species traits (animal ears, tail, horns) when they have them. Follow the card's appearance text exactly where it has one. No names, no count tags (1girl), no clothes, no expressions, no body-size or sexual tags.`,
      `- "outfit": the clothes for THIS scene as tags per part (head = hat / glasses / hair accessory, top, bottom, legs = socks / legwear, feet = shoes; "" when nothing), fitting the card and the story. Write colours even for black-and-white art (code removes them there).`,
      `- Code adds these tags to every panel of that character, so the character looks the same in every panel. ${undesigned ? "Leave out a card that describes a story, a setting or a narrator instead of one person." : ""}`.trimEnd(),
    );
  if (designed)
    parts.push(
      `Characters marked "designed earlier" keep their look; pick their outfit from the wardrobe like the others. Only when the story clearly puts them in clothes that match no wardrobe outfit, add {"name", "outfit": {...}} for them to "looks" (no identity).`,
    );
  if (!freeCharacters) parts.push(`Anyone not listed above appears only as an unnamed background person in the base tags (e.g. "store clerk in background"), never in "characters" or as a balloon speaker.`);
  return parts.join("\n");
}
