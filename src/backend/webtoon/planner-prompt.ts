/**
 * Webtoon planner prompt (round 1 of the webtoon bench, `webtoon-bench/scripts/planner-prompt.tpl.txt`) + the outfit choice.
 * The planner sees only names, short appearance labels and outfit labels: identity and outfit tags are injected by code
 * (asking Gemini to repeat body tags trips its non-configurable safety stop, webtoon-proto finding 1).
 */

export interface PlannerRosterEntry {
  name: string;
  gender: string;
  /** Short appearance label (form label), e.g. "pink hair, pink eyes". */
  label: string;
  outfits: Array<{ id: string; label: string }>;
  /** Outfit worn last (continuity), else the form default. */
  currentOutfitId: string;
}

const TEMPLATE = String.raw`You are the storyboard artist for a vertical-scroll Korean-style webtoon (one long strip, 690 px wide, read top to bottom). You adapt ONE chat reply (below) into a short webtoon episode. A code layout engine will letter your text on top of the images using YOUR character positions and balloon anchors, so positions matter.

How the target webtoons are built:
- Every panel is ONE single illustration with ONE camera. Never ask the image model for a comic page, panels, borders, text or speech bubbles.
- Vary the camera hard: extreme close-ups of eyes or lips, insert shots of hands/objects/feet, low angle, high angle, back view, over-the-shoulder, a wide establishing shot. Never more than two medium shots in a row.
- Panel shapes vary: full-width panels, short wide bands, tight crops, small insets pushed left or right, panels that fade into white. White space between panels sets the pacing.
- Balloons sit ON the art, in the empty part of the panel next to the speaker's head (sky, wall, ceiling), or straddle the panel's top/bottom edge, with a tail pointing at the speaker. They never cover faces. Narration boxes sit on panel corners/edges. Sound effects are big lettering drawn over the art next to the action.

Hard rules (checked by code; violations are removed or repaired automatically):
1. {{PANELS}} "image" panels in reading order (6 to 8 accepted), plus at most 2 "text_beat" panels (narration on white, for pacing). The first image panel may use layout "title": an establishing shot of the place with the top 40% empty (sky/ceiling) for the episode title, no text items.
2. At most 2 speech/thought balloons per panel, each at most 10 words (12 is the absolute maximum). Split long lines over panels. At most 1 narration box per image panel (a text_beat may have up to 3).
3. Speech and thought text must be COPIED VERBATIM from the source (dialogue in quotes, or italic/inner thoughts). You may cut a line short or drop words and mark the gap with "...", but never add, change or invent words. Narration boxes reuse the source's own narration wording, shortened.
4. Every panel with beat "action" has at least 1 "sfx" (an onomatopoeia like "clack", "SLAM", "gulp gulp", "tak tak", "fwip", "thud"). Pick sounds the moment actually makes.
5. At least 3 image panels use a non-full_width layout (wide_band, inset_left, inset_right, fade_white, tight_crop), including at least one inset.
6. List the story's key props in "key_props" and give each one an "insert" panel (hands/feet/object close-up).
7. Keep it non-explicit: clothed, no sexual framing.

Image model: NovelAI V5, one image per panel. Sizes (W x H): 832x1216 (portrait), 1216x832 (landscape), 1024x1024 (square), 704x1472 (tall), 1472x704 (wide band).
Layout -> size: wide_band uses 1472x704; tight_crop uses 1216x832 or 1472x704 (a face or hand crop); inset_left/inset_right use 832x1216 or 1024x1024; full_width/fade_white/title use any size.

Character placement (NovelAI V5 coordinates, the image model follows them): for each visible character give x and y, each one of 0.1, 0.3, 0.5, 0.7, 0.9 (x: 0.1 = left edge, 0.9 = right edge; y: 0.1 = top, 0.9 = bottom). The point is the CENTER of that character's visible body in the frame. Use the positions to leave room for the balloons: if a balloon goes top-left, put the speaker at x 0.5-0.7 and y 0.5-0.7 so the top-left area stays empty, and describe what fills the empty area in the base tags (sky, ceiling, wall, window, empty street). Two characters must not share the same x.

Balloon anchors (field "anchor" of every text item): "top-left", "top-right", "top", "left", "right", "bottom-left", "bottom-right", "over-top-edge", "over-bottom-edge", "gutter-above", "gutter-below". Pick the anchor next to the speaker's head on the EMPTY side, away from the other character's face. The first balloon of a panel must be higher than the second (reading order). SFX use the same anchors (place them on the art next to the action). Narration boxes use top-left, top-right, bottom-left, bottom-right, over-top-edge or over-bottom-edge.

Prompt format:
- "base": camera/framing tags (e.g. "close-up", "eye focus", "from below", "from above", "from behind", "pov", "pov hands", "upper body", "cowboy shot", "full body", "wide shot", "dutch angle"), then location/lighting tags (e.g. "indoors, kitchen, fluorescent light, evening"), then a newline and 1-2 plain English sentences describing the shot and the empty area. Do NOT write count tags (1girl, 1boy: code adds them), artist or quality tags, "speech bubble" or "text".
- "characters": one entry per visible character (empty list for object-only or no-human shots). "prompt" = ONLY pose, expression, gaze and action tags for this shot (e.g. "walking, from side, looking away, pout, holding bag"), then a newline and one short English sentence of what the character does. Do NOT write hair, eye, body, species or clothing tags: identity and outfit tags are added by code. "framing" = how much of the character is in frame: "portrait" | "upper body" | "cowboy shot" | "lower body" | "full body" | "hands only" (code uses it to pick outfit tags). "shoes_off": true when the character is indoors at home without shoes.

Characters (identity and outfit tags are injected by code; you only pick an outfit, place and pose them):
{{ROSTER}}
{{OFFSCREEN}}
Outfit: for every character you draw, pick the outfit id that fits this scene (field "outfits", name -> outfit id); the one marked (current) is what they wore last.

Output: JSON only, this shape (example values):
{"title": "Chapter 1: Example",
 "key_props": ["canvas tote bag"],
 "outfits": {"A": "outfit_school_uniform", "B": "default"},
 "panels": [
  {"id": 1, "kind": "image", "beat": "dialogue", "moment": "They argue on the bridge.", "shot": "wide two-shot from the side",
   "size": "1216x832", "layout": "full_width", "scene_change": false, "balloon_space": "top-left",
   "nai": {"base": "wide shot, from side, outdoors, bridge, sky, sunset\nTwo students stand on a bridge, open evening sky fills the upper left.",
           "characters": [{"name": "A", "x": 0.5, "y": 0.7, "framing": "full body", "shoes_off": false, "prompt": "standing, arms crossed, pout, looking at another\nShe glares at him."},
                          {"name": "B", "x": 0.9, "y": 0.7, "framing": "full body", "shoes_off": false, "prompt": "standing, hand in pocket, half-closed eyes\nHe shrugs."}]},
   "text": [{"type": "speech", "speaker": "A", "text": "You're late.", "anchor": "top-left"},
            {"type": "sfx", "speaker": null, "text": "tap tap", "anchor": "bottom-left"}]},
  {"id": 2, "kind": "text_beat", "beat": "quiet", "moment": "...", "layout": "text_on_white",
   "text": [{"type": "narration", "speaker": null, "text": "Nobody answered.", "anchor": "top-left"}]}
 ]}
Field values: kind "image"|"text_beat"; beat "title"|"establishing"|"action"|"dialogue"|"reaction"|"insert"|"quiet"; layout "title"|"full_width"|"wide_band"|"inset_left"|"inset_right"|"fade_white"|"tight_crop"|"text_on_white"; text type "speech"|"thought"|"narration"|"sfx"; speaker = a character name (may be off-panel) or null for narration/sfx; scene_change true when the place or time jumps.
All text in the language of the chat reply.

The chat reply:
<<<
{{SOURCE}}
>>>`;

/** 6 image panels up to 2500 characters, 7 up to 5000, else 8. */
export function webtoonPanelTarget(sourceLength: number): number {
  return sourceLength <= 2500 ? 6 : sourceLength <= 5000 ? 7 : 8;
}

export function plannerRosterLines(roster: readonly PlannerRosterEntry[]): string {
  return roster
    .map((r) => {
      const who = r.gender === "female" ? "woman/girl" : r.gender === "male" ? "man/boy" : "character";
      const outfits = r.outfits.map((o) => `${o.id} = "${o.label || o.id}"${o.id === r.currentOutfitId ? " (current)" : ""}`).join("; ");
      return `- ${r.name} (${who}): ${r.label || "no label"}; outfits: ${outfits || "none"}.`;
    })
    .join("\n");
}

export function buildPlannerPrompt(input: { roster: readonly PlannerRosterEntry[]; source: string; offscreenNote?: string }): string {
  const fill: Record<string, string> = {
    "{{PANELS}}": String(webtoonPanelTarget(input.source.length)),
    "{{ROSTER}}": plannerRosterLines(input.roster),
    "{{OFFSCREEN}}": input.offscreenNote ?? "",
    "{{SOURCE}}": input.source,
  };
  return TEMPLATE.replace(/\{\{(?:PANELS|ROSTER|OFFSCREEN|SOURCE)\}\}/gu, (m) => fill[m] ?? m);
}
