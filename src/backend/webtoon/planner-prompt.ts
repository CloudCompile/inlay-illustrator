// Round 2 of the webtoon bench (webtoon-bench2/scripts/planner-prompt.ts), copied for Inlay Illustrator; Inlay changes are marked "Inlay:".
// Inlay: the target panel count follows the message length, and the planner picks one outfit per character from the
// wardrobe (labels + items only; identity / body tags never reach the planner: Gemini's safety stop, webtoon-proto finding 1).
import type { PlannerCharacter } from "./storyboard-schema.js";

export const PLANNER_PROMPT_TEMPLATE = String.raw`You are the storyboard artist for a vertical-scroll Korean-style webtoon (one long strip, 690 px wide, read top to bottom). You adapt ONE chat reply (below) into a short webtoon episode. A code layout engine letters your text on top of the images using YOUR character positions and balloon anchors, so positions matter.

How the target webtoons are built:
- Every panel is ONE single illustration with ONE camera. Never ask the image model for a comic page, panels, borders, text or speech bubbles.
- Panels are BIG: most panels are full width and tall (portrait), the reader scrolls through one strong image at a time. Short wide bands are only for establishing shots and object inserts. White gaps between panels are short; only a deliberate pause gets a long white gap.
- Vary the camera hard: extreme close-ups of eyes or lips, insert shots of hands/objects/feet, low angle, high angle, back view, over-the-shoulder, a wide establishing shot. Never more than two medium shots in a row.
- Balloons sit ON the art, in the empty part of the panel next to the speaker's head (sky, wall, ceiling), or straddle the panel's top/bottom edge, with a tail pointing at the speaker. They never cover faces. Narration boxes sit on the panel's corners. Sound effects are big bold lettering over the art, and on action beats they break out of the panel frame.

Hard rules (checked by code; violations are removed or repaired automatically):
1. {{PANELS}} "image" panels in reading order ({{MIN}} to {{MAX}} accepted). The first image panel may use layout "title": an establishing shot of the place with the top 40% empty (sky/ceiling) for the episode title, no text items.
2. At most 2 speech/thought balloons per panel, each at most 10 words (12 is the absolute maximum). Split long lines over panels.
3. Narration goes ON the image panels: up to 2 narration boxes per image panel (one at a top corner = before the panel's dialogue, one at a bottom corner = after it). Use at most 1 "text_beat" panel (narration on white), only for a deliberate pause (a time skip or a punchline beat), and set "pause": true on it.
4. Speech and thought text must be COPIED VERBATIM from the source (dialogue in quotes, or italic/inner thoughts). You may cut a line short, drop words and mark the gap with "...", or join the parts of ONE line that the source splits with a speech tag ("No," she said. "I was..." -> "No, I was..."). Never add, change or invent words. Narration boxes reuse the source's own narration wording, shortened.
5. Sound effects: use MANY, bold and short. Every "action" panel gets 1-2 sfx (an onomatopoeia like "SLAM", "clack", "tak tak", "fwip", "thud", "gulp"), and quieter panels get ambient or emotional sfx (footsteps, door creak, rustle, "ba-dump", "shff", "tick tock") where the moment makes a sound. Aim for at least 5 sfx in the episode. Mark physical action moments (opening, grabbing, turning, dropping, running, slamming) with beat "action": code lets the sfx and the character break out of the panel frame there.
6. List the story's key props in "key_props" and give each one an "insert" panel (hands/feet/object close-up).
7. Keep it non-explicit: clothed, no sexual framing.

Image model: NovelAI V5, one image per panel. Sizes (W x H): 832x1216 (portrait), 704x1472 (tall), 1024x1024 (square), 1216x832 (landscape), 1472x704 (wide band).
Pick sizes like a webtoon artist: portrait 832x1216 or tall 704x1472 for every shot that shows a character, including close-ups and most two-shots (stack them: one in front, one behind, or use a low/high angle). 1216x832 only for a two- or three-shot that truly needs width. 1472x704 only for an establishing shot of a place or an insert of an object/hands.
Layouts:
- "full_width" (default, the big panel; any portrait/tall/landscape size).
- "inset_left" / "inset_right": a large panel (72% of the width) pushed to one side; the free column beside it takes the balloons. Use 832x1216 or 1024x1024. Good for single-character dialogue or reaction shots.
- "wide_band": 1472x704, ONLY for beat "establishing" or "insert".
- "tight_crop": a short crop on eyes, lips or hands (beat "reaction" or "insert"), 1216x832 or 1472x704.
- "fade_white": full width, fades into white at the bottom (quiet ending, transition).
- "title": the first panel only (see rule 1).
Use at least one inset per episode.

Character placement (NovelAI V5 coordinates, the image model follows them): for each visible character give x and y, each one of 0.1, 0.3, 0.5, 0.7, 0.9 (x: 0.1 = left edge, 0.9 = right edge; y: 0.1 = top, 0.9 = bottom). The point is the CENTER of that character's visible body in the frame. Use the positions to leave room for the balloons: if a balloon goes top-left, put the speaker at x 0.5-0.7 and y 0.5-0.7 so the top-left area stays empty, and describe what fills the empty area in the base tags (sky, ceiling, wall, window, empty street). Two characters must not share the same x.

Text anchors (field "anchor" of every text item): "top-left", "top-right", "top", "left", "right", "bottom-left", "bottom-right", "over-top-edge", "over-bottom-edge". Pick the balloon anchor next to the speaker's head on the EMPTY side, away from the other character's face. The first balloon of a panel must be higher than the second (reading order). SFX use the same anchors (next to the action). Narration boxes use the corner anchors (top-left, top-right, bottom-left, bottom-right).

Prompt format:
- "base": camera/framing tags (e.g. "close-up", "eye focus", "from below", "from above", "from behind", "pov", "pov hands", "upper body", "cowboy shot", "full body", "wide shot", "dutch angle"), then location/lighting tags (e.g. "indoors, kitchen, fluorescent light, evening"), then a newline and 1-2 plain English sentences describing the shot and the empty area. Do NOT write count tags (1girl, 1boy: code adds them), artist or quality tags, "speech bubble" or "text".
- "characters": one entry per visible character (empty list for object-only or no-human shots). "prompt" = ONLY pose, expression, gaze and action tags for this shot (e.g. "walking, from side, looking away, pout, holding bag"), then a newline and one short English sentence of what the character does. Do NOT write hair, eye, body, species or clothing tags: identity and outfit tags are added by code. "framing" = how much of the character is in frame: "portrait" | "upper body" | "cowboy shot" | "lower body" | "full body" | "hands only" (code uses it to pick outfit tags). "shoes_off": true when the character is indoors at home without shoes.
- "drop_outfit": the outfits come from a fixed wardrobe record and can contain items that only make sense in one place (indoor slippers, house shoes, an apron, a lab coat). When an item clearly contradicts THIS panel's scene (e.g. indoor "uwabaki" school slippers on the street), list it here, copied exactly from the character's item list. Do not drop items just because they are small or hidden; leave the list empty otherwise.

Characters (identity and outfit tags are injected by code; you only pick an outfit, place and pose them):
{{ROSTER}}
{{OFFSCREEN}}
Outfit: for every character you draw, pick the wardrobe outfit that fits this scene (field "outfits": [{"name", "outfit_id"}]); the one marked (current) is what they wore last. "drop_outfit" items refer to the picked outfit.

Output: JSON only, this shape (example values):
{"title": "Chapter 1: Example",
 "key_props": ["canvas tote bag"],
 "outfits": [{"name": "A", "outfit_id": "school_uniform"}, {"name": "B", "outfit_id": "default"}],
 "panels": [
  {"id": 1, "kind": "image", "beat": "dialogue", "moment": "They argue on the bridge.", "shot": "low-angle two-shot, she is in front",
   "size": "832x1216", "layout": "full_width", "scene_change": false, "balloon_space": "top-left",
   "nai": {"base": "cowboy shot, from below, outdoors, bridge, sky, sunset\nTwo students on a bridge, open evening sky fills the upper left.",
           "characters": [{"name": "A", "x": 0.5, "y": 0.7, "framing": "cowboy shot", "shoes_off": false, "drop_outfit": [], "prompt": "standing, arms crossed, pout, looking at another\nShe glares at him."},
                          {"name": "B", "x": 0.9, "y": 0.5, "framing": "upper body", "shoes_off": false, "drop_outfit": ["indoor slippers"], "prompt": "hand in pocket, half-closed eyes\nHe shrugs."}]},
   "text": [{"type": "narration", "speaker": null, "text": "The bridge was empty.", "anchor": "top-right"},
            {"type": "speech", "speaker": "A", "text": "You're late.", "anchor": "top-left"},
            {"type": "sfx", "speaker": null, "text": "tap tap", "anchor": "bottom-left"}]},
  {"id": 2, "kind": "text_beat", "beat": "quiet", "pause": true, "layout": "text_on_white",
   "text": [{"type": "narration", "speaker": null, "text": "Nobody answered.", "anchor": "top-left"}]}
 ]}
Field values: kind "image"|"text_beat"; beat "title"|"establishing"|"action"|"dialogue"|"reaction"|"insert"|"quiet"; layout "title"|"full_width"|"inset_left"|"inset_right"|"wide_band"|"tight_crop"|"fade_white"|"text_on_white"; text type "speech"|"thought"|"narration"|"sfx"; speaker = a character name (may be off-panel) or null for narration/sfx; scene_change true when the place or time jumps.
All text in the language of the chat reply.

The chat reply:
<<<
{{SOURCE}}
>>>
`;

const PARTS = ["head", "top", "bottom", "legs", "feet"] as const;

/** Inlay: a roster entry with the character's wardrobe (outfit id, label, items) and the outfit worn last. */
export interface PlannerRosterEntry {
  name: string;
  gender: string;
  formLabel: string;
  outfits: Array<{ id: string; label: string; outfit: PlannerCharacter["outfit"] }>;
  currentOutfitId: string;
}

export const WEBTOON_MIN_PANELS = 4;
/** Measured on the 17k-char bench chapter (webtoon-polish.md): the planner stays valid and under 2 minutes at this count. */
export const WEBTOON_MAX_PANELS = 14;

/** About one image panel per 1,000 characters, 4 to WEBTOON_MAX_PANELS. */
export function webtoonPanelTarget(sourceLength: number): number {
  return Math.min(WEBTOON_MAX_PANELS, Math.max(WEBTOON_MIN_PANELS, Math.round(sourceLength / 1000)));
}

/** Image panel counts the run accepts for a target: up to 2 fewer or 2 more, inside the global bounds. */
export function webtoonPanelRange(target: number): { min: number; max: number } {
  return { min: Math.max(WEBTOON_MIN_PANELS, target - 2), max: Math.min(WEBTOON_MAX_PANELS, target + 2) };
}

function items(outfit: PlannerCharacter["outfit"]): string {
  return PARTS.filter((k) => outfit[k]?.trim()).map((k) => `${k}: ${outfit[k]}`).join("; ");
}

export function rosterLines(roster: readonly PlannerRosterEntry[]): string {
  return roster
    .map((r) => {
      const who = r.gender === "female" ? "woman/girl" : r.gender === "male" ? "man/boy" : "character";
      const wardrobe = r.outfits
        .map((o) => `${o.id}${o.id === r.currentOutfitId ? " (current)" : ""} = "${o.label || o.id}"${items(o.outfit) ? ` (items: ${items(o.outfit)})` : ""}`)
        .join("; ");
      return `- ${r.name} (${who}): ${r.formLabel || "no label"}; wardrobe: ${wardrobe || "none"}.`;
    })
    .join("\n");
}

export function buildPlannerPrompt(args: { roster: readonly PlannerRosterEntry[]; source: string; panels: number; offscreenNote?: string }): string {
  const range = webtoonPanelRange(args.panels);
  const fill: Record<string, string> = {
    "{{PANELS}}": String(args.panels),
    "{{MIN}}": String(range.min),
    "{{MAX}}": String(range.max),
    "{{ROSTER}}": rosterLines(args.roster),
    "{{OFFSCREEN}}": args.offscreenNote ?? "",
    "{{SOURCE}}": args.source,
  };
  return PLANNER_PROMPT_TEMPLATE.replace(/\{\{(?:PANELS|MIN|MAX|ROSTER|OFFSCREEN|SOURCE)\}\}/gu, (m) => fill[m] ?? m);
}

/** Inlay: the planner's outfit pick per character (unknown ids fall back to the current outfit). */
export function chosenOutfits(raw: unknown, roster: readonly PlannerRosterEntry[], log: string[]): Record<string, string> {
  const picks = new Map<string, string>();
  const list = raw && typeof raw === "object" && Array.isArray((raw as { outfits?: unknown }).outfits) ? ((raw as { outfits: unknown[] }).outfits) : [];
  for (const entry of list) {
    const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    if (typeof e.name === "string" && typeof e.outfit_id === "string") picks.set(e.name.trim(), e.outfit_id.trim());
  }
  const out: Record<string, string> = {};
  for (const r of roster) {
    const pick = picks.get(r.name);
    const ok = !!pick && r.outfits.some((o) => o.id === pick);
    if (pick && !ok) log.push(`${r.name}: unknown outfit "${pick}" -> ${r.currentOutfitId}`);
    if (ok || r.currentOutfitId) out[r.name] = ok ? pick! : r.currentOutfitId;
  }
  return out;
}
