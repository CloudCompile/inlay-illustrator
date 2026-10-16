// Round 2 of the webtoon bench (webtoon-bench2/scripts/storyboard-schema.ts), copied for Inlay Illustrator; Inlay changes are marked "Inlay:".
// Storyboard schema for the webtoon planner (pure module: types, constants, JSON schema; no IO).

export const IMAGE_SIZES = ["832x1216", "704x1472", "1024x1024", "1216x832", "1472x704"] as const;
/** Manga: the NovelAI size closest to the page cell (Opus free sizes, area <= 1024 x 1024). */
export const MANGA_SIZES = ["1600x640", "1472x704", "1216x832", "1024x1024", "832x1216", "704x1472", "640x1600"] as const;
export const PORTRAIT_SIZES = ["832x1216", "704x1472"];
export const LAYOUTS = ["title", "full_width", "inset_left", "inset_right", "wide_band", "tight_crop", "fade_white", "text_on_white"] as const;
export const BEATS = ["title", "establishing", "action", "dialogue", "reaction", "insert", "quiet"] as const;
export const ANCHORS = ["top-left", "top-right", "top", "left", "right", "bottom-left", "bottom-right", "over-top-edge", "over-bottom-edge"] as const;
export const FRAMINGS = ["portrait", "upper body", "cowboy shot", "lower body", "full body", "hands only"] as const;
export const TEXT_TYPES = ["speech", "thought", "narration", "sfx"] as const;
export const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];

export type ImageSize = (typeof IMAGE_SIZES)[number] | (typeof MANGA_SIZES)[number];
export type Importance = "small" | "normal" | "big";
export type Layout = (typeof LAYOUTS)[number];
export type Beat = (typeof BEATS)[number];
export type Anchor = (typeof ANCHORS)[number];
export type Framing = (typeof FRAMINGS)[number];
export type TextType = (typeof TEXT_TYPES)[number];

export interface StoryCharacter {
  name: string;
  x: number; // NovelAI center, one of GRID
  y: number;
  framing: Framing;
  shoes_off?: boolean;
  drop_outfit?: string[]; // exact outfit items that contradict this panel's scene (e.g. indoor slippers outdoors)
  prompt: string; // pose/expression tags, newline, one sentence
}

export interface TextItem {
  type: TextType;
  speaker: string | null;
  text: string;
  anchor: Anchor;
  /** Manga: a shouted line (burst balloon) or a whisper (dashed balloon). */
  tone?: "shout" | "whisper";
}

export interface ImagePanel {
  id: number;
  kind: "image";
  beat: Beat;
  moment?: string;
  shot?: string;
  size: ImageSize;
  layout: Exclude<Layout, "text_on_white">;
  scene_change?: boolean;
  balloon_space?: string;
  /** Inlay: the character pops out over the top of the frame (cut-out + inpainted background); kept by the validator on 1-2 eligible panels. */
  frame_break?: boolean;
  /** Manga: panel size on the page (code picks the page template and the image size from it). */
  importance?: Importance;
  nai: { base: string; characters: StoryCharacter[] };
  text: TextItem[];
}

export interface TextBeatPanel {
  id: number;
  kind: "text_beat";
  beat: Beat;
  moment?: string;
  layout: "text_on_white";
  pause?: boolean; // deliberate pacing pause; other text beats are merged into the neighbouring image panel
  scene_change?: boolean;
  text: TextItem[];
}

export type Panel = ImagePanel | TextBeatPanel;

export interface Storyboard {
  title: string;
  key_props?: string[];
  panels: Panel[];
  /** Manga: page templates and the image panel ids on each page, in reading order. */
  pages?: MangaPage[];
}

export interface MangaPage {
  template: string;
  panels: number[];
}

/** Roster entry the planner sees: names, short labels and outfit items (never identity/body tags). */
export interface PlannerCharacter {
  name: string;
  gender: "female" | "male" | string;
  formLabel: string;
  outfitLabel: string;
  outfit: Partial<Record<"head" | "top" | "bottom" | "legs" | "feet", string>>;
}

const str = { type: "string" };
const num = { type: "number" };
const textItem = {
  type: "object",
  properties: { type: { type: "string", enum: [...TEXT_TYPES] }, speaker: { type: ["string", "null"] }, text: str, anchor: { type: "string", enum: [...ANCHORS] } },
  required: ["type", "text", "anchor"],
};

/** JSON schema of the planner output (for responseJsonSchema / structured output). */
export const STORYBOARD_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: str,
    key_props: { type: "array", items: str },
    panels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          kind: { type: "string", enum: ["image", "text_beat"] },
          beat: { type: "string", enum: [...BEATS] },
          moment: str,
          shot: str,
          size: { type: "string", enum: [...IMAGE_SIZES] },
          layout: { type: "string", enum: [...LAYOUTS] },
          scene_change: { type: "boolean" },
          pause: { type: "boolean" },
          frame_break: { type: "boolean" },
          balloon_space: str,
          nai: {
            type: "object",
            properties: {
              base: str,
              characters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: str, x: num, y: num, framing: { type: "string", enum: [...FRAMINGS] }, shoes_off: { type: "boolean" },
                    drop_outfit: { type: "array", items: str }, prompt: str,
                  },
                  required: ["name", "x", "y", "framing", "prompt"],
                },
              },
            },
            required: ["base", "characters"],
          },
          text: { type: "array", items: textItem },
        },
        required: ["id", "kind", "beat", "layout", "text"],
      },
    },
  },
  required: ["title", "panels"],
};
