/**
 * Manga colour handling (pure). Manga pages follow the chat's artist style: when its positive prompt asks for greyscale or
 * monochrome with a positive weight, colour words in the identity, outfit, pose and scene text would beat it (manga prototype:
 * pink hair / red ribbons / "orange light" came out in colour or spot colour), so they are stripped and every character prompt
 * starts with MONO_TAGS. Black and white stay: they are tones.
 */

import type { PanelRequest, WebtoonCastMember } from "./panel-request.js";
import type { ImagePanel } from "./storyboard-schema.js";

export const MONO_TAGS = "monochrome, greyscale";
const MONO = new Set(["greyscale", "grayscale", "monochrome"]);

/** NovelAI prompt text -> [text, weight] runs (`1.2::tags ::` weighted groups, everything else weight 1). */
function weightedRuns(prompt: string): Array<[string, number]> {
  const parts = prompt.split("::");
  const runs: Array<[string, number]> = [];
  let weight: number | null = null;
  parts.forEach((part, i) => {
    if (weight !== null) {
      runs.push([part, weight]);
      weight = null;
      return;
    }
    const opener = i < parts.length - 1 ? /(-?\d*\.?\d+)\s*$/u.exec(part) : null;
    runs.push([opener ? part.slice(0, opener.index) : part, 1]);
    if (opener) weight = Number(opener[1]);
  });
  return runs;
}

/** True when the style's positive prompt asks for greyscale / monochrome with a positive weight ("-1::greyscale ::" does not). */
export function isMonochromeStyle(positive: string): boolean {
  return weightedRuns(positive).some(([text, weight]) =>
    weight > 0 && text.split(/[,\n]/u).some((tag) => MONO.has(tag.replace(/[{}[\]()]/gu, "").trim().toLowerCase())),
  );
}

const COLOUR =
  "red|orange|yellow|green|blue|purple|violet|pink|brown|grey|gray|silver|gold|golden|blonde|blond|platinum|teal|cyan|magenta|beige|navy|maroon|crimson|scarlet|amber|aqua|aquamarine|turquoise|lavender|lilac|indigo|khaki|olive|peach|emerald|ruby|sapphire|azure|multicolou?red|colou?rful|rainbow|two-tone";
const COLOUR_WORD = new RegExp(
  `\\b(?:(?:light|dark|pale|bright|deep|pastel|neon|hot|baby|sky|dusty|vivid)[\\s-]+)?(?:${COLOUR})(?:[\\s-]*(?:colou?red|tinted|ish))?\\b`,
  "giu",
);
/** What is left of a tag that only named a colour ("pink hair" -> "hair"): dropped. */
const BARE = /^(?:hair|eyes?|pupils|irises|skin|hair and eyes|and|&)?$/iu;

function stripPiece(piece: string): string {
  if (piece.includes("(")) return piece; // character tags with a series name: "rin \(blue archive\)"
  const lead = /^\s*/u.exec(piece)![0];
  const out = piece
    .replace(COLOUR_WORD, " ")
    .replace(/(?:\s*(?:-|\/|&|\band\b))+\s*$/iu, "")
    .replace(/^(?:\s*(?:-|\/|&|and\b))+\s*/iu, "")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return BARE.test(out) ? "" : lead + out;
}

/**
 * Prompt text without colour words (weights and line breaks kept): "1.1::pink hair::, red hair ribbons" -> "hair ribbons";
 * "black thighhighs" and "white shirt" stay.
 */
export function stripColours(prompt: string): string {
  type Token = { tag: string } | { open: string } | { close: true } | { nl: true };
  const tokens: Token[] = [];
  prompt.split(/(-?\d*\.?\d+::|::|,|\n)/u).forEach((t, i) => {
    if (i % 2 === 0) {
      const tag = stripPiece(t).trim();
      if (tag) tokens.push({ tag });
    } else if (t === "\n") tokens.push({ nl: true });
    else if (t === "::") tokens.push({ close: true });
    else if (t !== ",") tokens.push({ open: t });
  });
  let out = "";
  let comma = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if ("tag" in t) {
      out += (comma ? ", " : "") + t.tag;
      comma = true;
    } else if ("nl" in t) {
      out += "\n";
      comma = false;
    } else if ("open" in t) {
      const next = tokens[i + 1];
      if (next && "close" in next) i++; // the weighted group is empty now
      else {
        out += (comma ? ", " : "") + t.open;
        comma = false;
      }
    } else {
      out += "::";
      comma = true;
    }
  }
  return out;
}

/** Cast with colour words stripped from identity and outfit tags. */
export function monoCast(cast: ReadonlyMap<string, WebtoonCastMember>): Map<string, WebtoonCastMember> {
  return new Map([...cast].map(([name, m]) => [name, {
    ...m,
    identity: stripColours(m.identity),
    outfit: Object.fromEntries(Object.entries(m.outfit).map(([part, tags]) => [part, stripColours(tags ?? "")])),
  }]));
}

/** The planner's scene and pose text without colour words. */
export function monoPanel(panel: ImagePanel): ImagePanel {
  return { ...panel, nai: { base: stripColours(panel.nai.base), characters: panel.nai.characters.map((c) => ({ ...c, prompt: stripColours(c.prompt) })) } };
}

/** MONO_TAGS first in every character prompt (plain and cut-out). */
export function withMonoTags(request: PanelRequest): PanelRequest {
  const mono = (prompt: string) => `${MONO_TAGS}, ${prompt}`;
  return {
    ...request,
    characters: request.characters.map((c) => ({ ...c, prompt: mono(c.prompt) })),
    ...(request.cutout ? { cutout: { ...request.cutout, characters: request.cutout.characters.map(mono) } } : {}),
  };
}
