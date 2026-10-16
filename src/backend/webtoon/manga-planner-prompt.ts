/**
 * Manga planner prompt (manga prototype `manga-proto/scripts/planner-prompt.ts`, adapted from the webtoon planner): page-based
 * manga read right to left; per panel an importance (small / normal / big) and a shot; code picks the page templates and the
 * image sizes. Inlay additions as in the webtoon planner: panel count by length, wardrobe + outfit pick, frame-break marks; and
 * the prototype's lettering findings: shout / whisper tones, sound effects from the source's own sound words, one source line per
 * balloon, outbursts as their own beats. Identity / body tags never reach the planner (webtoon finding 1).
 */
import { rosterLines, webtoonPanelRange, type PlannerRosterEntry } from "./planner-prompt.js";

export const MANGA_PLANNER_TEMPLATE = String.raw`You are the storyboard artist ("name" / thumbnail artist) for a Japanese manga. You adapt ONE chat reply (below) into a short manga chapter of about {{PAGES}} pages. Pages are read right to left: panels in a row from right to left, rows from top to bottom. Code builds the pages from a small library of page templates and letters your text on top of the images, so you decide WHAT each panel shows and how IMPORTANT it is; code decides the exact panel shapes.

How the target manga are built:
- Every panel is ONE single illustration with ONE camera. Never ask the image model for a manga page, panels, borders, text or speech bubbles.
- Rhythm: a page has 4-7 panels. Each page has one big panel (the strongest beat of the page: a reveal, an emotional peak, an establishing view), several normal panels, and small panels for quick beats (a reaction face, an insert of hands/objects/feet, a pause).
- Vary the camera hard like a manga artist: extreme close-ups of eyes, insert shots of hands/objects/feet, low angle, high angle, back view, over-the-shoulder, a wide establishing shot of the street or room. Never more than two medium shots in a row. The chapter opens with an establishing panel.
- Outbursts are the best manga beats: a shouted line, a sudden reaction or a punchline ("You don't have a hand mixer?!") gets its own panel (a head snap, a close-up reaction) instead of sharing a panel with calm lines.
- Speech balloons sit in the empty part of the panel next to the speaker's head; they may cross the panel border into the white gutter. Narration sits in rectangular boxes at a panel corner. Sound effects (SFX) are hand-lettered over the art.

Hard rules (checked by code; violations are removed or repaired automatically):
1. {{PANELS}} panels in reading order ({{MIN}} to {{MAX}} accepted).
2. "importance" per panel: "big" (about 1 per page), "small" (quick reaction, insert, pause: about 1/3 of the panels), "normal" (the rest).
3. At most 2 speech/thought balloons per panel, each ONE short beat of at most 8 words (12 is the absolute maximum): split a long line into two balloons at a sentence break. A "small" panel gets at most 1 balloon.
4. Up to 1 narration box per panel (at most 12 words). Narration reuses the source's own narration wording, shortened.
5. Speech and thought text must be COPIED VERBATIM from the source (dialogue in quotes, or italic/inner thoughts). You may cut a line short, drop words and mark the gap with "...", or join the parts of ONE line that the source splits with a speech tag. Never join two different lines (from different moments) into one balloon. Never add, change or invent words.
6. "tone" of a speech balloon: "shout" when the line is yelled or snapped (an exclamation, "she yelled"), "whisper" when it is whispered, muttered or said under the breath; leave it out otherwise.
7. Sound effects: short English onomatopoeia. When the source writes a sound ("*click*", "bzzt", "thud", a door that slams, a phone that buzzes), use that sound: copy the source's sound word, or write the sound the source describes (a silent text alert is "bzzt", not "ring"; loafers on stairs "click click"; a pillow hit "fwump"). Every "action" panel gets 1 sfx; quiet panels may get an ambient one. Aim for 5-8 sfx in the chapter.
8. List the story's key props in "key_props" and give the most important ones an "insert" panel (hands/feet/object close-up, framing "hands only" or no characters).
9. Keep it non-explicit: clothed, no sexual framing, no suggestive tags.

Image model: NovelAI V5, one image per panel (code picks the size from the panel shape).{{STYLE}}

Character placement (NovelAI V5 coordinates, the image model follows them): for each visible character give x and y, each one of 0.1, 0.3, 0.5, 0.7, 0.9 (x: 0.1 = left edge, 0.9 = right edge; y: 0.1 = top, 0.9 = bottom). The point is the CENTER of that character's visible body in the frame. Leave room for balloons: with a speaker at x 0.3 the right side stays empty for the balloon (manga balloons are read first at the top RIGHT). Two characters must not share the same x. In a two-shot, put the character who speaks FIRST on the RIGHT.
Frame-break: set "frame_break": true on 1 "action" panel per page at most, where ONE character makes a strong move (framing "portrait", "upper body" or "cowboy shot", character y 0.5 so the head sits in the upper half). Code cuts that character out and draws the head over the panel's top frame line. Leave "frame_break" false on every other panel.

Prompt format:
- "base": camera/framing tags (e.g. "close-up", "eye focus", "from below", "from above", "from behind", "pov", "upper body", "cowboy shot", "full body", "wide shot", "dutch angle"), then location/lighting tags (e.g. "indoors, kitchen, evening"), then a newline and 1-2 plain English sentences describing the shot. Do NOT write count tags (1girl, 1boy: code adds them), artist, style or quality tags, "speech bubble" or "text".
- "characters": one entry per visible character (empty list for object-only or no-human shots). "prompt" = ONLY pose, expression, gaze and action tags for this shot (e.g. "walking, from side, looking away, pout, holding bag"), then a newline and one short English sentence of what the character does. Do NOT write hair, eye, body, species or clothing tags: identity and outfit tags are added by code. "framing" = "portrait" | "upper body" | "cowboy shot" | "lower body" | "full body" | "hands only". "shoes_off": true when indoors at home without shoes.
- "drop_outfit": when an outfit item clearly contradicts THIS panel's scene (e.g. indoor "uwabaki" school slippers on the street, shoes indoors), list it here, copied exactly from the character's item list; otherwise leave it empty.

Characters (identity and outfit tags are injected by code; you only pick an outfit, place and pose them):
{{ROSTER}}
Outfit: for every character you draw, pick the wardrobe outfit that fits this scene (field "outfits": [{"name", "outfit_id"}]); the one marked (current) is what they wore last. "drop_outfit" items refer to the picked outfit.

Output: JSON only, this shape (example values):
{"title": "Chapter 1: Example",
 "key_props": ["canvas tote bag"],
 "outfits": [{"name": "A", "outfit_id": "school_uniform"}, {"name": "B", "outfit_id": "default"}],
 "panels": [
  {"id": 1, "importance": "big", "beat": "establishing", "shot": "wide shot from below, the bridge and evening sky", "moment": "They walk onto the bridge.", "frame_break": false,
   "nai": {"base": "wide shot, from below, full body, outdoors, bridge, sky, sunset\nTwo students walk onto a long bridge under a wide evening sky.",
           "characters": [{"name": "A", "x": 0.7, "y": 0.7, "framing": "full body", "shoes_off": false, "drop_outfit": [], "prompt": "walking, arms crossed, pout\nShe walks ahead, sulking."},
                          {"name": "B", "x": 0.3, "y": 0.7, "framing": "full body", "shoes_off": false, "drop_outfit": [], "prompt": "walking, hand in pocket, half-closed eyes\nHe follows her."}]},
   "text": [{"type": "narration", "speaker": null, "text": "The bridge was empty."},
            {"type": "speech", "speaker": "A", "text": "You're late!", "tone": "shout"},
            {"type": "sfx", "speaker": null, "text": "tap tap"}]},
  {"id": 2, "importance": "small", "beat": "insert", "shot": "close-up of her hand on the bag strap", "moment": "...", "nai": {"base": "...", "characters": []}, "text": []}
 ]}
Field values: importance "small"|"normal"|"big"; beat "establishing"|"action"|"dialogue"|"reaction"|"insert"|"quiet"; text type "speech"|"thought"|"narration"|"sfx"; tone "shout"|"whisper" (speech only, optional); speaker = a character name (may be off-panel) or null for narration/sfx; text items in reading order.
All text in the language of the chat reply.

The chat reply:
<<<
{{SOURCE}}
>>>
`;

/** Page count hint: 4 to 6 panels per page. */
export function mangaPagesHint(panels: number): string {
  const lo = Math.max(1, Math.ceil(panels / 6)), hi = Math.max(1, Math.ceil(panels / 4));
  return lo === hi ? String(lo) : `${lo}-${hi}`;
}

export function buildMangaPlannerPrompt(args: { roster: readonly PlannerRosterEntry[]; source: string; panels: number; mono: boolean }): string {
  const range = webtoonPanelRange(args.panels);
  const style = args.mono
    ? " The art style is black-and-white manga (greyscale): do not rely on colours to tell characters or things apart; use pose, framing, props and light, and write no colour words."
    : "";
  const fill: Record<string, string> = {
    "{{PANELS}}": String(args.panels),
    "{{MIN}}": String(range.min),
    "{{MAX}}": String(range.max),
    "{{PAGES}}": mangaPagesHint(args.panels),
    "{{STYLE}}": style,
    "{{ROSTER}}": rosterLines(args.roster),
    "{{SOURCE}}": args.source,
  };
  return MANGA_PLANNER_TEMPLATE.replace(/\{\{(?:PANELS|MIN|MAX|PAGES|STYLE|ROSTER|SOURCE)\}\}/gu, (m) => fill[m] ?? m);
}
