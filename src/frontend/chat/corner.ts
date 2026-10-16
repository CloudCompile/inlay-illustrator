/**
 * Screen corner of the chat runtime host (generation-count toggle + toast stack). A per-device preference
 * (localStorage, not the Asset Maid config), edited in the drawer launcher and applied live.
 */
export type RuntimeCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export const RUNTIME_CORNER_OPTIONS: Array<{ value: RuntimeCorner; label: string }> = [
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-right", label: "Top right" },
  { value: "top-left", label: "Top left" }
];
export const DEFAULT_RUNTIME_CORNER: RuntimeCorner = "bottom-right";

/** The key dates from the removed floating button; kept so a saved corner carries over. */
const STORAGE_KEY = "inlay-illustrator:fab-corner";

export function normalizeRuntimeCorner(value: unknown): RuntimeCorner {
  const text = String(value ?? "").trim().toLowerCase();
  return RUNTIME_CORNER_OPTIONS.find((option) => option.value === text)?.value ?? DEFAULT_RUNTIME_CORNER;
}

export interface RuntimeCornerPreference {
  get(): RuntimeCorner;
  set(corner: RuntimeCorner): void;
  subscribe(listener: (corner: RuntimeCorner) => void): () => void;
}

export function runtimeCornerPreference(storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): RuntimeCornerPreference {
  const listeners = new Set<(corner: RuntimeCorner) => void>();
  let current = DEFAULT_RUNTIME_CORNER;
  try {
    current = normalizeRuntimeCorner(storage?.getItem(STORAGE_KEY));
  } catch {
    // storage unavailable: default corner
  }
  return {
    get: () => current,
    set(corner) {
      current = corner;
      try {
        storage?.setItem(STORAGE_KEY, corner);
      } catch {
        // private mode: the choice lasts for this page only
      }
      for (const listener of [...listeners]) listener(corner);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
