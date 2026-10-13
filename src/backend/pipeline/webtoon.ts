/**
 * Experimental webtoon mode (chat image generation setting `webtoonMode`). Each message is planned as vertical webtoon
 * segments: the comic presentation with its own scene direction, a tall frame, a segment count from the message
 * length, and the longest analyzer timeout (a long message is planned in one call).
 */
import { ANALYZER_TIMEOUT_MAX_MS, type AnalyzerSettings } from "../../shared/contract/index.js";

/** Not a built-in or user size id; the engine takes the size from `requestedSize`. */
export const WEBTOON_SIZE = { id: 7041472, width: 704, height: 1472 } as const;
export const WEBTOON_ANALYZER_TIMEOUT_MS = ANALYZER_TIMEOUT_MAX_MS;
const CHARS_PER_SEGMENT = 1250;
const MAX_SEGMENTS = 16;

export const WEBTOON_SCENE_INSTRUCTION = [
  "Frame: every segment is a tall vertical strip 704 × 1472 pixels; compose all panels inside it.",
  "Render each requested illustration as one vertical webtoon segment: a piece of a single continuous top-to-bottom scroll, not a printed manga page. The segments for this message are read back to back, so together they must retell the whole message in story order.",
  "Segment selection: spread the segments across the entire message from its opening to its final beat, in order, so no major turn of the scene is skipped and no two segments repeat the same moment. Give each segment one beat, a moment where something changes: an action with a consequence, a reveal, a decision, an emotional turn, or a punchline. Leave out connective description, ambient detail, and micro-reactions unless they are the point of the beat.",
  "Layout: stack panels in a single column read strictly top to bottom; never place panels side by side in a grid. Let the beat's action, emotion, and timing drive bold variation in panel height, camera distance, angle, and focus. Consecutive panels must never repeat the same camera and composition: move from an establishing shot to a close-up, cut to an insert of the key object or hand, flip to the listener's reaction, or drop to a low or high angle when power shifts. Give the peak of the segment the largest panel, borderless or bleeding past the frame when it lands hard. Separate panels with clear gutter space, wider where time passes or the mood shifts. Usually two to four panels; a single panel when one image carries the beat.",
  "Dialogue: give speech bubbles only to the lines that carry the beat, the lines a reader would quote, usually one to three per segment, each in the speaker's own words and cut to its core when long. Let silent panels carry reactions.",
].join("\n");

const WEBTOON_PRESET = {
  id: "scene-webtoon",
  name: "Webtoon",
  instruction: WEBTOON_SCENE_INSTRUCTION,
  scenePresetId: "comic",
  controlOverrides: { "comic.frame": false },
};

/** About one segment per 1250 characters of the cleaned message (the density tuned on long chapters), 1..16. */
export function webtoonSegmentCount(clean: string): number {
  return Math.max(1, Math.min(MAX_SEGMENTS, Math.round(clean.trim().length / CHARS_PER_SEGMENT)));
}

/** `novelai.v5UserDirections.scene` that selects the webtoon direction (the image-ratio direction is kept). */
export function webtoonSceneDirections(v5UserDirections: unknown): Record<string, unknown> {
  const current = v5UserDirections && typeof v5UserDirections === "object" ? (v5UserDirections as Record<string, unknown>) : {};
  return {
    ...current,
    scene: {
      mode: "preset",
      selectedPresetId: WEBTOON_PRESET.id,
      presetId: WEBTOON_PRESET.scenePresetId,
      presets: [WEBTOON_PRESET],
      controlOverrides: WEBTOON_PRESET.controlOverrides,
      customText: WEBTOON_PRESET.instruction,
    },
  };
}

export function webtoonAnalysisConfig(analysis: AnalyzerSettings): AnalyzerSettings {
  return { ...analysis, timeoutMs: WEBTOON_ANALYZER_TIMEOUT_MS };
}
