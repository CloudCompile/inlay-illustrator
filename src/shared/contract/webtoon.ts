/**
 * Webtoon strip layout as stored and rendered: output of the backend layout engine (src/backend/webtoon/layout.ts, round 2
 * of the webtoon bench), input of the live-DOM renderer. Coordinates are strip pixels (690 px design width) unless noted.
 */
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
}
/** `textIndex`: index into the storyboard panel's text list (the text edit target). */
export interface BalloonItem {
  kind: "speech" | "thought"; panel: number; textIndex: number; speaker: string | null; text: string; lines: string[]; cx: number; cy: number; rx: number; ry: number;
  textW: number; textH: number; tail: Point | null; shout: boolean; rect: Rect; fallback: string | null;
}
export interface NarrationItem { kind: "narration"; panel: number; textIndex: number; text: string; lines: string[]; rect: Rect; fallback: string | null }
export interface SfxItem { kind: "sfx"; panel: number; textIndex: number; text: string; cx: number; cy: number; size: number; rot: number; color: string; rect: Rect; breaksFrame: boolean }
export interface TitleItem { kind: "title"; panel: number; small: string; big: string; y: number }
export type LaidItem = BalloonItem | NarrationItem | SfxItem | TitleItem;
export interface StripLayout { width: number; height: number; panels: PanelLayout[]; items: LaidItem[]; log: string[] }

/* ------------------------------------------------------------------------------------------------
 * Strip state per message swipe (experimental webtoon mode), as the chat view reads it (`webtoon.get`)
 * ---------------------------------------------------------------------------------------------- */

export type WebtoonStripStatus = "planning" | "generating" | "complete" | "error" | "cancelled";

export interface WebtoonPanelTake {
  imageId: string;
  /** `/api/v1/image-gen/results/<imageId>`. */
  url: string;
  seed: string;
  width: number;
  height: number;
  createdAt: number;
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
  /** Increments on every write (the chat view refetches when it changes). */
  revision: number;
  title: string;
  /** Null until the storyboard is planned. */
  layout: StripLayout | null;
  panels: Record<string, WebtoonPanelState>;
  updatedAt: number;
}

/** Per-message summary carried by `ChatMessageUiState.webtoon`. */
export interface WebtoonStripSummary {
  revision: number;
  status: WebtoonStripStatus;
}
