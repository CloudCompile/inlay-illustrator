/**
 * Webtoon strip layout as stored and rendered: output of the backend layout engine (src/backend/webtoon/layout.ts),
 * input of the live-DOM renderer. All coordinates are strip pixels (690 px wide) unless noted.
 */
export type Rect = [number, number, number, number];
export type Point = [number, number];

export interface LayoutPanel {
  panelId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Normalized sx0, sy0, sx1, sy1 of the source image shown in the box. */
  crop: Rect;
  mask: "fade-bottom" | "fade-sides" | null;
  title?: { small: string; big: string; y: number };
}
export interface LayoutItemBase {
  panelId: string;
  /** Index into the panel's text[]. */
  textIndex: number;
  text: string;
  lines: string[];
  /** Strip coords x0, y0, x1, y1. */
  rect: Rect;
  fallback?: string | null;
}
export interface BalloonItem extends LayoutItemBase {
  kind: "speech" | "thought";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  tail: Point | null;
  shout: boolean;
  speaker: string | null;
  textBox: { x: number; y: number; w: number; h: number };
}
export interface NarrationItem extends LayoutItemBase { kind: "narration" }
export interface SfxItem extends LayoutItemBase { kind: "sfx"; cx: number; cy: number; size: number; rot: number; color: string }
export type LayoutItem = BalloonItem | NarrationItem | SfxItem;

export interface StripLayout {
  version: 1;
  width: 690;
  height: number;
  panels: LayoutPanel[];
  items: LayoutItem[];
}

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
