/**
 * Webtoon strip layout as rendered: output of the backend layout engine (src/backend/webtoon/layout.ts, round 2 of the
 * webtoon bench), input of the live-DOM renderer. Coordinates are strip pixels (`StripLayout.width` wide) unless noted.
 */

/** Design width of the strip (desktop). */
export const STRIP_WIDTH = 690;
/** Narrowest layout width the backend lays out. */
export const STRIP_MIN_LAYOUT_WIDTH = 360;
/** Balloon text size in strip pixels (layout.ts `RULES.speech.size`). */
export const STRIP_SPEECH_PX = 19;
/** Smallest balloon text on screen, CSS px. */
export const STRIP_MIN_TEXT_PX = 12;

/** Comic format of a strip: a vertical webtoon strip, or manga pages (read right to left). */
export type ComicFormat = "webtoon" | "manga";
/** Manga page width in layout px (pages are 1:1.414). */
export const MANGA_PAGE_WIDTH = 1100;
/** Manga balloon text size on a page, layout px (12.5 px on screen at the 690 px desktop frame). */
export const MANGA_SPEECH_PX = 20;

/**
 * Layout width for a strip shown `renderWidth` CSS px wide: 690 when the scaled balloon text stays at least 12 px,
 * else narrower, so text keeps its size and the panels get smaller around it.
 */
export function stripLayoutWidth(renderWidth: number): number {
  const width = Math.floor((renderWidth * STRIP_SPEECH_PX) / STRIP_MIN_TEXT_PX);
  return Math.min(STRIP_WIDTH, Math.max(STRIP_MIN_LAYOUT_WIDTH, width));
}
/**
 * Layout width for manga shown `renderWidth` CSS px wide: whole pages (MANGA_PAGE_WIDTH) when the page text stays at least
 * 12 px, else the phone layout (one panel per line) at the webtoon width rule.
 */
export function mangaLayoutWidth(renderWidth: number): number {
  return renderWidth * MANGA_SPEECH_PX >= MANGA_PAGE_WIDTH * STRIP_MIN_TEXT_PX ? MANGA_PAGE_WIDTH : stripLayoutWidth(renderWidth);
}
export type Rect = [number, number, number, number]; // x0, y0, x1, y1 in strip px
export type Point = [number, number];

export interface PanelLayout {
  id: number;
  rect: Rect; // where the whole (cropped) image is drawn
  crop: [number, number, number, number]; // normalized source window shown in rect
  frame: Rect; // visible panel frame (equals rect unless the panel breaks its frame)
  frameBreak: "top" | "left" | "right" | null;
  cutout: { src: string } | null; // drawn over the image inside rect, unclipped by frame
  fade: "bottom" | "sides" | null;
  heads: Record<string, Point>;
  faces: Record<string, Rect | null>;
  /** Manga: the visible frame as a polygon (slanted cuts), strip px; drawn with a black border. */
  clip?: Point[];
}
/** `textIndex`: index into the storyboard panel's text list (the text edit target). */
export interface BalloonItem {
  kind: "speech" | "thought"; panel: number; textIndex: number; speaker: string | null; text: string; lines: string[]; cx: number; cy: number; rx: number; ry: number;
  textW: number; textH: number; tail: Point | null; shout: boolean; rect: Rect; fallback: string | null;
  /** Manga: dashed whisper balloon; text size / line height in layout px (else the webtoon CSS size). */
  whisper?: boolean; fontSize?: number; lineHeight?: number;
}
export interface NarrationItem { kind: "narration"; panel: number; textIndex: number; text: string; lines: string[]; rect: Rect; fallback: string | null; fontSize?: number; lineHeight?: number }
export interface SfxItem { kind: "sfx"; panel: number; textIndex: number; text: string; cx: number; cy: number; size: number; rot: number; color: string; rect: Rect; breaksFrame: boolean }
export interface TitleItem { kind: "title"; panel: number; small: string; big: string; y: number }
/** Manga chapter box: the chapter title boxed in a corner of the first panel (`fontSize` of the big line, layout px). */
export interface ChapterBox { panel: number; small: string; big: string; rect: Rect; fontSize: number }
export type LaidItem = BalloonItem | NarrationItem | SfxItem | TitleItem;
export interface StripLayout {
  width: number; height: number; panels: PanelLayout[]; items: LaidItem[]; log: string[];
  /** Manga: white page sheets (whole pages, or the pages' panels stacked one per line on phones); panels drawn in greyscale when `grey`. */
  format?: "manga"; pages?: Rect[]; grey?: boolean; chapter?: ChapterBox;
}

/* ------------------------------------------------------------------------------------------------
 * Strip state per message swipe (experimental webtoon mode), as the chat view reads it (`webtoon.get`)
 * ---------------------------------------------------------------------------------------------- */

export type WebtoonStripStatus = "planning" | "generating" | "complete" | "error" | "cancelled";

/** Normalized box in image coordinates (0..1). */
export interface CutoutBox { left: number; top: number; right: number; bottom: number }

/** Character cut-out of a frame-break take (drawn over the panel image, unclipped by the frame). */
export interface WebtoonPanelCutout {
  imageId: string;
  url: string;
  /** Box of the solid pixels. */
  bbox: CutoutBox;
  /** Character area: rows of "0" / "1" cells over the whole image (balloons keep off the "1" cells). */
  mask: string[];
}

export interface WebtoonPanelTake {
  imageId: string;
  /** `/api/v1/image-gen/results/<imageId>`; a composed frame-break panel (an upload): `/api/v1/images/<imageId>`. */
  url: string;
  seed: string;
  width: number;
  height: number;
  createdAt: number;
  /** Frame-break take: the panel image is the inpainted background with this cut-out drawn in. */
  cutout?: WebtoonPanelCutout;
  /** Vision check of this take (Jev 1.14 through a TypeSafe Decision connection); absent when it did not run. */
  check?: WebtoonPanelCheck;
}

/** Face boxes and identity checks of one take. The layout keeps balloons off these faces. */
export interface WebtoonPanelCheck {
  model: string;
  /** Face box per character name (normalized image coords); only answers above the confidence gate. */
  faces: Record<string, CutoutBox>;
  /** Identity checks ("species", "hair:<colour> hair", "glasses") with their noul answers. */
  identity: Array<{ name: string; check: string; noul: number }>;
  /** Smallest margin of an identity check above its threshold (1 when there is none); the better take has the larger score. */
  score: number;
  /** Identity checks below their threshold. */
  failed: string[];
  /** This take is the automatic identity redraw (new seed, boosted identity tags). */
  redraw?: boolean;
}

export interface WebtoonPanelState {
  panelId: string;
  status: "pending" | "generating" | "done" | "error";
  takes: WebtoonPanelTake[];
  /** Index into `takes` of the take shown (-1 = none yet). */
  selected: number;
  error?: string;
}

export interface WebtoonStripView {
  chatId: string;
  /** `illustration:<messageId>@<swipe>`. */
  messageKey: string;
  status: WebtoonStripStatus;
  error?: string;
  /** Manga pages (absent: webtoon strip). */
  format?: "manga";
  /** Increments on every write (the chat view refetches when it changes). */
  revision: number;
  title: string;
  /** Laid out for the requested width; null until the storyboard is planned. */
  layout: StripLayout | null;
  panels: Record<string, WebtoonPanelState>;
  updatedAt: number;
}

/** Per-message summary carried by `ChatMessageUiState.webtoon`. */
export interface WebtoonStripSummary {
  revision: number;
  status: WebtoonStripStatus;
  /** Manga pages (absent: webtoon strip); the chat view picks the layout width rule from it. */
  format?: "manga";
}
