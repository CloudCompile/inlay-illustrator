/**
 * Character reference images for generic image providers (OpenAI, Gemini, ...).
 *
 * The user picks where the baseline reference for a character comes from: the character's avatar (default, their
 * canonical look) or one image from their Lumiverse gallery. The image is read through the host (`characters.get` /
 * `characters.getGallery` + `images.readBinary`) and handed to the provider as a reference/baseline image, so the
 * generated art matches the character's established style and appearance.
 */
import type { SpindleHost } from "./types.js";

export type CharacterReferenceSource = "avatar" | "gallery";

export interface CharacterReferenceOptions {
  source: CharacterReferenceSource;
  /** Index into the gallery, in gallery order; clamped. Ignored for "avatar". */
  galleryIndex?: number;
}

/** MIME type from the leading magic bytes (PNG/JPEG/WebP/GIF); defaults to image/png. */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return "image/png";
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Lumiverse image id of the character's reference image (avatar, or the gallery item at `galleryIndex`). */
export async function characterReferenceImageId(
  host: Pick<SpindleHost, "characters">,
  characterId: string,
  options: CharacterReferenceOptions,
  userId?: string,
): Promise<string | null> {
  if (!characterId) return null;
  if (options.source === "gallery") {
    const gallery = (await host.characters.getGallery?.(characterId, userId)) ?? [];
    if (!gallery.length) return null;
    const index = Math.max(0, Math.min(gallery.length - 1, Math.trunc(options.galleryIndex ?? 0)));
    return gallery[index]?.image_id ?? gallery[0]?.image_id ?? null;
  }
  const character = await host.characters.get(characterId, userId);
  return character?.image_id ?? null;
}

/**
 * Read a character's reference image as `{ data (base64), mimeType }`. Returns null when the character, the image id,
 * or the host `images.readBinary` capability is missing. Failures are returned, not thrown, so a missing reference
 * never fails the whole generation.
 */
export async function readCharacterReference(
  host: Pick<SpindleHost, "characters" | "images">,
  characterId: string,
  options: CharacterReferenceOptions,
  userId?: string,
): Promise<{ data: string; mimeType: string } | null> {
  if (typeof host.images?.readBinary !== "function") return null;
  const imageId = await characterReferenceImageId(host, characterId, options, userId);
  if (!imageId) return null;
  let bytes: Uint8Array;
  try {
    bytes = await host.images.readBinary(imageId, userId);
  } catch {
    return null;
  }
  if (!bytes || !bytes.length) return null;
  return { data: base64FromBytes(bytes), mimeType: sniffImageMime(bytes) };
}
