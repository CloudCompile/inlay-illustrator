import { describe, expect, test } from "bun:test";
import { createFakeHost } from "../testing/fake-host.js";
import { characterReferenceImageId, readCharacterReference, sniffImageMime } from "./character-reference.js";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP_BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("sniffImageMime", () => {
  test("detects PNG / JPEG / WebP / GIF, defaults to PNG", () => {
    expect(sniffImageMime(PNG_BYTES)).toBe("image/png");
    expect(sniffImageMime(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageMime(WEBP_BYTES)).toBe("image/webp");
    expect(sniffImageMime(Uint8Array.from([0x47, 0x49, 0x46, 0x38])).slice(0, 9)).toBe("image/gif");
    expect(sniffImageMime(Uint8Array.from([1, 2, 3]))).toBe("image/png");
  });
});

describe("characterReferenceImageId", () => {
  test("avatar source returns the character image_id", async () => {
    const fake = createFakeHost();
    fake.addCharacter({ id: "c1", name: "Alice", image_id: "avatar-1" });
    expect(await characterReferenceImageId(fake.host, "c1", { source: "avatar" }, fake.userId)).toBe("avatar-1");
  });

  test("gallery source returns the image at the index, clamped", async () => {
    const fake = createFakeHost();
    fake.addCharacter({ id: "c1", name: "Alice", image_id: "avatar-1" });
    fake.galleries.set("c1", [
      { id: "g1", image_id: "img-a", reference: "gallery://a", caption: "", sort_order: 0, created_at: 0, width: null, height: null, mime_type: "image/png" },
      { id: "g2", image_id: "img-b", reference: "gallery://b", caption: "", sort_order: 1, created_at: 0, width: null, height: null, mime_type: "image/png" },
    ]);
    expect(await characterReferenceImageId(fake.host, "c1", { source: "gallery", galleryIndex: 1 }, fake.userId)).toBe("img-b");
    expect(await characterReferenceImageId(fake.host, "c1", { source: "gallery", galleryIndex: 9 }, fake.userId)).toBe("img-b");
    expect(await characterReferenceImageId(fake.host, "c1", { source: "gallery" }, fake.userId)).toBe("img-a");
  });

  test("empty character id or gallery returns null", async () => {
    const fake = createFakeHost();
    expect(await characterReferenceImageId(fake.host, "", { source: "avatar" }, fake.userId)).toBeNull();
    fake.addCharacter({ id: "c1", name: "Alice", image_id: null });
    expect(await characterReferenceImageId(fake.host, "c1", { source: "gallery" }, fake.userId)).toBeNull();
  });
});

describe("readCharacterReference", () => {
  test("reads avatar bytes as base64 with a sniffed mime", async () => {
    const fake = createFakeHost();
    fake.addCharacter({ id: "c1", name: "Alice", image_id: "avatar-1" });
    fake.addImage({ id: "avatar-1" }, PNG_BYTES);
    const ref = await readCharacterReference(fake.host, "c1", { source: "avatar" }, fake.userId);
    expect(ref?.mimeType).toBe("image/png");
    expect(typeof ref?.data).toBe("string");
    expect(ref!.data.length).toBeGreaterThan(0);
  });

  test("missing image id or bytes returns null", async () => {
    const fake = createFakeHost();
    fake.addCharacter({ id: "c1", name: "Alice", image_id: null });
    expect(await readCharacterReference(fake.host, "c1", { source: "avatar" }, fake.userId)).toBeNull();
    fake.addCharacter({ id: "c2", name: "Bob", image_id: "missing" });
    expect(await readCharacterReference(fake.host, "c2", { source: "avatar" }, fake.userId)).toBeNull();
  });
});
