/**
 * Webtoon strip storage: one document per message swipe, `chats/<chatId>/webtoon/<messageId>@<swipe>.json`, plus
 * `chats/<chatId>/webtoon/index.json` (revision + status per swipe, read by `chatDom.getMessageStates`).
 * The document keeps the planner output (raw + validated storyboard, validation log), the exact panel requests, every
 * take (image id + seed), the selected take and text overrides. The layout is computed from all of that per view, at the
 * width the chat shows the strip (older documents also carry a stored 690 px `layout`; it is not read).
 */
import {
  MANGA_PAGE_WIDTH,
  STORAGE_PATHS,
  STRIP_MIN_LAYOUT_WIDTH,
  STRIP_WIDTH,
  imageResultUrl,
  safePathSegment,
  type StripLayout,
  type WebtoonPanelState,
  type WebtoonStripStatus,
  type WebtoonStripSummary,
  type WebtoonStripView,
} from "../../shared/contract/index.js";
import type { StorageService } from "../services/types.js";
import { layoutStrip, type PanelImage } from "./layout.js";
import { layoutManga } from "./manga-layout.js";
import type { PanelRequest, WebtoonStyle } from "./panel-request.js";
import type { Storyboard } from "./storyboard-schema.js";

export interface PlannerCall {
  ms: number;
  finishReason: string;
  parsed: boolean;
  hardOk: boolean;
  error?: string;
}

export interface WebtoonStripDocument {
  schema: "inlay-illustrator.webtoon";
  version: 1;
  chatId: string;
  messageKey: string;
  historyId: string;
  characterId: string;
  status: WebtoonStripStatus;
  error?: string;
  /** Manga pages (absent: webtoon strip). */
  format?: "manga";
  /** Manga in greyscale (the artist style asks for monochrome): prompts without colour words, panels drawn grey. */
  mono?: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
  sourceLength: number;
  planner: { model: string; calls: PlannerCall[] } | null;
  storyboardRaw: unknown;
  storyboard: Storyboard | null;
  validation: { log: string[]; stats: Record<string, unknown> } | null;
  /** Cast of this strip: name -> prompt key and chosen outfit; gender and identity tags for the vision check (absent in older documents). */
  cast: Array<{ name: string; key: string; outfitId: string; gender?: string; identity?: string }>;
  style: WebtoonStyle | null;
  /** Panel id -> exact request (prompts, size, centers). */
  requests: Record<string, PanelRequest>;
  panels: Record<string, WebtoonPanelState>;
  /** `<panelId>:<textIndex>` -> edited text. */
  textOverrides: Record<string, string>;
}

type Index = Record<string, WebtoonStripSummary>;

export const webtoonDir = (chatId: string) => `${STORAGE_PATHS.chatDir(chatId)}webtoon/`;
export const webtoonPath = (chatId: string, historyId: string) => `${webtoonDir(chatId)}${safePathSegment(historyId)}.json`;
const indexPath = (chatId: string) => `${webtoonDir(chatId)}index.json`;

export function createStripDocument(input: { chatId: string; messageKey: string; historyId: string; characterId: string; sourceLength: number; now: number; revision?: number }): WebtoonStripDocument {
  return {
    schema: "inlay-illustrator.webtoon",
    version: 1,
    chatId: input.chatId,
    messageKey: input.messageKey,
    historyId: input.historyId,
    characterId: input.characterId,
    status: "planning",
    revision: input.revision ?? 1,
    createdAt: input.now,
    updatedAt: input.now,
    sourceLength: input.sourceLength,
    planner: null,
    storyboardRaw: null,
    storyboard: null,
    validation: null,
    cast: [],
    style: null,
    requests: {},
    panels: {},
    textOverrides: {},
  };
}

export async function readStrip(storage: StorageService, chatId: string, historyId: string): Promise<WebtoonStripDocument | null> {
  const raw = await storage.readJson<WebtoonStripDocument | null>(webtoonPath(chatId, historyId), null);
  return raw && raw.schema === "inlay-illustrator.webtoon" && raw.version === 1 ? raw : null;
}

async function writeIndex(storage: StorageService, doc: WebtoonStripDocument | null, chatId: string, historyId: string): Promise<void> {
  await storage.updateJson<Index>(indexPath(chatId), {}, (index) => {
    const next = { ...index };
    if (doc) next[historyId] = { revision: doc.revision, status: doc.status, ...(doc.format === "manga" ? { format: "manga" as const } : {}) };
    else delete next[historyId];
    return next;
  });
}

/** Serialized read-modify-write of one strip; bumps `revision` / `updatedAt` and the index. */
export async function updateStrip(
  storage: StorageService,
  chatId: string,
  historyId: string,
  mutate: (doc: WebtoonStripDocument | null) => WebtoonStripDocument,
  now: () => number = Date.now,
): Promise<WebtoonStripDocument> {
  const written = await storage.updateJson<WebtoonStripDocument | null>(webtoonPath(chatId, historyId), null, (current) => {
    const valid = current && current.schema === "inlay-illustrator.webtoon" && current.version === 1 ? current : null;
    const next = mutate(valid ? structuredClone(valid) : null);
    return { ...next, revision: (valid?.revision ?? next.revision - 1) + 1, updatedAt: now() };
  });
  await writeIndex(storage, written!, chatId, historyId);
  return written!;
}

export async function deleteStrip(storage: StorageService, chatId: string, historyId: string): Promise<void> {
  await storage.delete(webtoonPath(chatId, historyId));
  await writeIndex(storage, null, chatId, historyId);
}

export async function stripSummaries(storage: StorageService, chatId: string): Promise<Index> {
  return storage.readJson<Index>(indexPath(chatId), {});
}

/** Storyboard with the text overrides applied, as the layout engine reads it. */
export function effectiveStoryboard(doc: Pick<WebtoonStripDocument, "storyboard" | "textOverrides">): Storyboard | null {
  if (!doc.storyboard) return null;
  return {
    ...doc.storyboard,
    panels: doc.storyboard.panels.map((p) => ({
      ...p,
      text: p.text.map((t, i) => {
        const edited = doc.textOverrides[`${p.id}:${i}`];
        return edited === undefined ? t : { ...t, text: edited };
      }),
    })),
  };
}

/**
 * Layout from the storyboard + overrides at `width`; image sizes, cut-out and face boxes from the selected takes, else the planned size.
 * Manga: pages at MANGA_PAGE_WIDTH, the phone layout below it.
 */
export function relayout(doc: WebtoonStripDocument, width: number = doc.format === "manga" ? MANGA_PAGE_WIDTH : STRIP_WIDTH): StripLayout | null {
  const storyboard = effectiveStoryboard(doc);
  if (!storyboard) return null;
  const images: Record<string, PanelImage> = {};
  for (const p of storyboard.panels) {
    if (p.kind !== "image") continue;
    const panel = doc.panels[String(p.id)];
    const take = panel?.takes[panel.selected];
    const [width, height] = p.size.split("x").map(Number) as [number, number];
    images[String(p.id)] = take?.width && take.height ? { width: take.width, height: take.height } : { width, height };
    if (take?.cutout) images[String(p.id)]!.cutout = { src: take.cutout.url, bbox: take.cutout.bbox, mask: take.cutout.mask };
    if (take?.check && Object.keys(take.check.faces).length) images[String(p.id)]!.faces = take.check.faces;
  }
  return doc.format === "manga" ? layoutManga(storyboard, images, { width, grey: !!doc.mono }) : layoutStrip(storyboard, images, { width });
}

/**
 * The chat view of a strip, laid out at `width` (strip px: `stripLayoutWidth` of the shown width; manga: `mangaLayoutWidth`,
 * MANGA_PAGE_WIDTH = pages, the default).
 */
export function stripView(doc: WebtoonStripDocument, width?: number): WebtoonStripView {
  const manga = doc.format === "manga";
  const w = Math.round(width ?? 0) || (manga ? MANGA_PAGE_WIDTH : STRIP_WIDTH);
  return {
    chatId: doc.chatId,
    messageKey: doc.messageKey,
    status: doc.status,
    ...(doc.error ? { error: doc.error } : {}),
    ...(manga ? { format: "manga" as const } : {}),
    revision: doc.revision,
    title: doc.storyboard?.title ?? "",
    layout: relayout(doc, manga && w >= MANGA_PAGE_WIDTH ? MANGA_PAGE_WIDTH : Math.min(STRIP_WIDTH, Math.max(STRIP_MIN_LAYOUT_WIDTH, w))),
    panels: doc.panels,
    updatedAt: doc.updatedAt,
  };
}

export function takeOf(imageId: string, seed: string, width: number, height: number, createdAt: number) {
  return { imageId, url: imageResultUrl(imageId), seed, width, height, createdAt };
}
