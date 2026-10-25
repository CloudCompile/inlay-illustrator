/**
 * Contact sheets of the outfit auto-picker: which groups go on which sheet, and the numbered 5x5 JPEG itself.
 * Built in the browser because the backend cannot decode WebP/AVIF.
 */
import { AUTOPICK_SHEETS_PER_JOB, AUTOPICK_TILES_PER_SHEET, type AutoPickCandidate, type AutoPickGroup, type AutoPickSheet } from "../../../shared/contract/autopick.js";

export interface SheetTile { groupId: string; candidate: number; url: string }

/**
 * Untagged groups of the chosen characters, 25 tiles per sheet, `AUTOPICK_SHEETS_PER_JOB` sheets per job. Groups whose
 * file names already say nude are left out: a tile would only confirm that (no garments, no label).
 */
export function planSheets(groups: AutoPickGroup[], promptKeys: ReadonlySet<string>, candidateOf: (group: AutoPickGroup) => number): SheetTile[][][] {
  const tiles = groups
    .filter((g) => g.promptKey && promptKeys.has(g.promptKey) && !g.tags && !g.nude && g.candidates.length)
    .map((g) => {
      const candidate = Math.min(candidateOf(g), g.candidates.length - 1);
      return { groupId: g.id, candidate, url: tileUrl(g.candidates[candidate]!) };
    });
  const sheets: SheetTile[][] = [];
  for (let i = 0; i < tiles.length; i += AUTOPICK_TILES_PER_SHEET) sheets.push(tiles.slice(i, i + AUTOPICK_TILES_PER_SHEET));
  const jobs: SheetTile[][][] = [];
  for (let i = 0; i < sheets.length; i += AUTOPICK_SHEETS_PER_JOB) jobs.push(sheets.slice(i, i + AUTOPICK_SHEETS_PER_JOB));
  return jobs;
}

/** Lumiverse's 700 px thumbnail: enough for a 300x420 cell, far lighter than the original. */
export function tileUrl(candidate: AutoPickCandidate): string {
  const thumb = candidate.thumbnailUrl || candidate.url;
  return /[?&]size=\w+/.test(thumb) ? thumb.replace(/([?&]size=)\w+/, "$1lg") : thumb;
}

const COLUMNS = 5;
const CELL_W = 300;
const CELL_H = 420;
const GAP = 6;

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/** Draws one sheet: portrait cells letterboxed on grey, the tile number in yellow on black at the top left. Tiles whose image fails to load are left out. */
export async function renderSheet(tiles: SheetTile[]): Promise<AutoPickSheet | null> {
  const images = await Promise.all(tiles.map((t) => loadImage(t.url)));
  const drawn = tiles.flatMap((tile, i) => (images[i] ? [{ tile, image: images[i]! }] : []));
  if (!drawn.length) return null;
  const rows = Math.ceil(drawn.length / COLUMNS);
  const canvas = document.createElement("canvas");
  canvas.width = COLUMNS * CELL_W + (COLUMNS + 1) * GAP;
  canvas.height = rows * CELL_H + (rows + 1) * GAP;
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#282828";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = "bold 40px sans-serif";
  g.textBaseline = "top";
  drawn.forEach(({ image }, i) => {
    const x = GAP + (i % COLUMNS) * (CELL_W + GAP);
    const y = GAP + Math.floor(i / COLUMNS) * (CELL_H + GAP);
    g.fillStyle = "#808080";
    g.fillRect(x, y, CELL_W, CELL_H);
    const scale = Math.min(CELL_W / image.naturalWidth, CELL_H / image.naturalHeight, 1);
    const w = Math.round(image.naturalWidth * scale);
    const h = Math.round(image.naturalHeight * scale);
    g.drawImage(image, x + Math.round((CELL_W - w) / 2), y + Math.round((CELL_H - h) / 2), w, h);
    const label = String(i + 1);
    const box = g.measureText(label).width + 14;
    g.fillStyle = "#000";
    g.fillRect(x, y, box, 50);
    g.fillStyle = "#ff0";
    g.fillText(label, x + 7, y + 6);
  });
  let dataUrl = "";
  try { dataUrl = canvas.toDataURL("image/jpeg", 0.86); } catch { return null; }
  const image = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return image ? { image, mimeType: "image/jpeg", tiles: drawn.map(({ tile }) => ({ groupId: tile.groupId, candidate: tile.candidate })) } : null;
}
