/**
 * Outfit auto-picker (Inlay addition; not in Asset Maid): proposes outfits with a reference image per character from a
 * card's image assets. Calls scale with the number of outfit groups, not images:
 *  - plan (1 call, a second one only when the first scheme covers too few names): the analyzer infers the card's asset
 *    naming scheme as a regex over sample names; the backend applies it to every name, groups assets by (character,
 *    outfit) and ranks a neutral representative per group with Asset Maid's filename tag table;
 *  - tag (1 call per contact sheet of up to 25 groups, built in the browser): garments per part as the image shows them,
 *    plus legs/feet from the character's own outfit text, kept apart so the image always wins;
 *  - apply: accepted groups become outfits with the representative as reference image.
 * State per character: `characters/<id>/autopick.json`.
 */
import type { AssetRef } from "./character.js";

export const AUTOPICK_TILES_PER_SHEET = 25;
/** Sheets per tag job (each is a ~0.5 MB JPEG in the request). */
export const AUTOPICK_SHEETS_PER_JOB = 4;

export interface AutoPickParts { head: string; top: string; bottom: string; legs: string; feet: string }

export interface AutoPickCandidate { asset: AssetRef; name: string; url: string; thumbnailUrl: string }

/** Vision tags of one representative (contact-sheet tile). */
export interface AutoPickTags {
  /** Index into `candidates` of the image that was tagged. */
  candidate: number;
  framing: string;
  nude: boolean;
  explicit: boolean;
  legsVisible: boolean;
  feetVisible: boolean;
  label: string;
  /** Garments as the image shows them. */
  outfit: AutoPickParts;
  /** Legwear / footwear the character's outfit text names for this outfit ("" when none). */
  textLegs: string;
  textFeet: string;
  taggedAt: string;
}

export interface AutoPickGroup {
  /** `${promptKey}\u0000${outfit}` (promptKey "" for character tokens that match no roster entry). */
  id: string;
  promptKey: string;
  characterToken: string;
  /** Normalized outfit token from the names ("" when the scheme has no outfit field: one group per character). */
  outfit: string;
  /** The outfit token names nudity (nude/naked): proposed unchecked. */
  nude: boolean;
  assetCount: number;
  /** Ranked representatives (best first, at most 3). */
  candidates: AutoPickCandidate[];
  tags?: AutoPickTags;
  /** Outfit created from this group (`autopick.apply`). */
  appliedOutfitId?: string;
}

export interface AutoPickScheme {
  regex: string;
  /** Prompt key of the only character when names carry no character field. */
  singleCharacterKey: string;
  /** Character token (lowercase) -> prompt key. */
  aliases: Record<string, string>;
  notes: string;
  /** Share of the card's asset names the regex matched. */
  coverage: number;
  assetCount: number;
  calls: number;
  createdAt: string;
}

export interface AutoPickState {
  version: 1;
  scheme: AutoPickScheme | null;
  groups: AutoPickGroup[];
  /** Sample of names the scheme did not match (usually backgrounds). */
  unmatched: string[];
  updatedAt: string;
}

/** One contact sheet: a JPEG (base64 without prefix) and the group id + candidate index of each tile in number order. */
export interface AutoPickSheet { image: string; mimeType: string; tiles: Array<{ groupId: string; candidate: number }> }

export interface AutoPickApplyItem { groupId: string; candidate: number; label: string; parts: AutoPickParts }

export const AUTOPICK_PARTS = ["head", "top", "bottom", "legs", "feet"] as const;

export function emptyAutoPickState(): AutoPickState {
  return { version: 1, scheme: null, groups: [], unmatched: [], updatedAt: "" };
}

export const autoPickGroupId = (promptKey: string, outfit: string) => `${promptKey}\u0000${outfit}`;

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Proposed parts of a tagged group: the image's garments; legs/feet from the outfit text only where the image does not
 * show that body part (sprites are usually cropped at the thighs or chest), named nothing there and does not already
 * show that garment elsewhere (thigh-high boots tagged as legs are not added again as feet).
 */
export function proposedParts(tags: AutoPickTags): { parts: AutoPickParts; fromText: Array<"legs" | "feet"> } {
  const parts = { ...tags.outfit };
  const fromText: Array<"legs" | "feet"> = [];
  const shown = AUTOPICK_PARTS.map((p) => squash(tags.outfit[p])).join("|");
  const fresh = (text: string) => !!squash(text) && !shown.includes(squash(text));
  if (!parts.legs.trim() && !tags.legsVisible && fresh(tags.textLegs)) {
    parts.legs = tags.textLegs.trim();
    fromText.push("legs");
  }
  if (!parts.feet.trim() && !tags.feetVisible && fresh(tags.textFeet)) {
    parts.feet = tags.textFeet.trim();
    fromText.push("feet");
  }
  return { parts, fromText };
}
