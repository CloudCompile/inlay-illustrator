/**
 * Image puppet rigs (Inlay addition; contract src/shared/contract/puppet.ts). One analysis-model vision call per chat
 * image returns its movable parts (outline, pivot, parent); the cleaned rig and the image's animate toggle are stored in
 * `puppets/<imageId>.json`. Requests for the same image share one call; at most PUPPET_CONCURRENCY calls run at a time.
 * Fallbacks: a model without vision fails `unsupported` (nothing stored, settings may change); a comic page, an image
 * without usable parts, or a filtered answer is stored as `failed` with the reason, so the image stays still until the
 * user asks again.
 */
import {
  emptyPuppetState,
  imageResultUrl,
  PUPPET_FAILURE_MESSAGES,
  PUPPET_GET_MAX_IDS,
  sanitizePuppetRig,
  STORAGE_PATHS,
  type PuppetFailureCode,
  type PuppetState,
} from "../../shared/contract/index.js";
import { fail, isAbortLike, toRpcError } from "../rpc/errors.js";
import type { BackendServices } from "../services/types.js";

export const PUPPET_CONCURRENCY = 2;

export const PUPPET_SYSTEM = `You rig illustrations for a very subtle idle animation (a puppet warp: parts gently sway, the background stays still).
Locate the movable parts of every character precisely. Coordinates are normalized to 0-1000 over the image.
Boxes are [ymin, xmin, ymax, xmax]; points are [y, x].`;

export const PUPPET_INSTRUCTIONS = `Return JSON only: {"comic": boolean, "parts": [Part, ...]} where Part is
{"label": string, "character": integer (0 for the first character), "box_2d": [ymin, xmin, ymax, xmax], "outline": [[y, x], ...], "pivot": [y, x], "attached_to": integer | null}.
"comic" is true when the image is a comic page or a layout of several separate panels (then "parts" may be empty).
"outline" is a closed polygon of 12-30 points tracing the visible silhouette of the part (follow fingers, hair tips and held objects closely).
"attached_to" is the index in "parts" of the part this one hangs from (null when none).

Labels (only the ones that exist; one part per instance):
- "torso": chest, shoulders and belly (no arms, no head). pivot: the waist center.
- "head": the head with face, ears, horns, hair on top of the head and hair accessories, but not hair hanging below the chin. pivot: the base of the neck, between the chin and the collarbones (not the face). attached_to: the torso.
- "hair": each long lock of hair hanging below the chin (left lock, right lock, back hair). pivot: where the lock leaves the head. attached_to: the head.
- "forearm": each visible hand together with its fingers and forearm, from the elbow to the fingertips. pivot: the elbow (where the forearm enters the frame or the body when the elbow is hidden). attached_to: the torso. Add "resting": true when the hand rests in or on something (pocket, hip, lap, table, railing, another person) and false when it is free or raised.
- "item": each object held in a hand. pivot: the grip point. attached_to: the forearm holding it.
- "appendage": wings, tails, antennae, animal ears not covered by the head, ribbons, capes. Add "kind" (wing, tail, antenna, ear, ribbon, cape). pivot: where it attaches to the body. attached_to: the head or torso it grows from. List every one of these as its own part even when it overlaps the head or torso box; the head outline excludes them.
Skip parts that are not visible. Do not include the background. Return {"comic": false, "parts": []} when no character is visible.`;

export interface PuppetService {
  /** Stored states (status "none" for images never rigged or unreadable files). */
  get(imageIds: readonly string[]): Promise<Record<string, PuppetState>>;
  /** Rig (unless a rig is stored and `force` is off) and turn the animation on. */
  rig(imageId: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<PuppetState>;
  setEnabled(imageId: string, enabled: boolean): Promise<PuppetState>;
}

const byUser = new WeakMap<object, PuppetService>();

/**
 * The user's puppet service, so the in-flight map and the call limit are per user. Keyed by the user's storage service:
 * RPC contexts are fresh objects per request, the services inside them are not.
 */
export function puppetService(services: BackendServices): PuppetService {
  let service = byUser.get(services.storage);
  if (!service) byUser.set(services.storage, (service = createPuppetService(services)));
  return service;
}

function needId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail("bad-request", "imageId is required.");
  const id = value.trim();
  try {
    STORAGE_PATHS.puppet(id);
  } catch {
    fail("bad-request", `Invalid imageId: ${id}`);
  }
  return id;
}

function normalize(imageId: string, raw: unknown): PuppetState {
  const r = raw && typeof raw === "object" ? (raw as Partial<PuppetState>) : null;
  if (!r || (r.status !== "ready" && r.status !== "failed")) return emptyPuppetState(imageId);
  if (r.status === "ready" && !(r.rig && Array.isArray(r.rig.parts) && r.rig.parts.length)) return emptyPuppetState(imageId);
  return { ...r, imageId, status: r.status, enabled: r.status === "ready" && r.enabled === true, updatedAt: String(r.updatedAt ?? "") } as PuppetState;
}

const FILTERED = /safety|prohibited|blocked|blocklist|content[ _-]?filter|recitation/iu;

export function createPuppetService(services: BackendServices, options: { now?: () => string } = {}): PuppetService {
  const now = options.now ?? (() => new Date().toISOString());
  const inflight = new Map<string, Promise<PuppetState>>();
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = () => (running < PUPPET_CONCURRENCY ? (running++, Promise.resolve()) : new Promise<void>((resolve) => waiting.push(() => (running++, resolve()))));
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  const read = async (imageId: string) => normalize(imageId, await services.storage.readJson<unknown>(STORAGE_PATHS.puppet(imageId), null));
  const update = (imageId: string, mutate: (current: PuppetState) => PuppetState) =>
    services.storage
      .updateJson<unknown>(STORAGE_PATHS.puppet(imageId), null, (raw) => mutate(normalize(imageId, raw)))
      .then((saved) => normalize(imageId, saved));
  const failed = (imageId: string, code: PuppetFailureCode) =>
    update(imageId, () => ({ imageId, status: "failed", enabled: false, failure: { code, message: PUPPET_FAILURE_MESSAGES[code] }, updatedAt: now() }));

  async function runRig(imageId: string, signal?: AbortSignal): Promise<PuppetState> {
    if (!(await services.llm.supportsVision()))
      fail("unsupported", "The analysis model can't read images. Choose a model with vision in the analysis settings to animate images.");
    const image = await services.imageBytes.getImage({ url: imageResultUrl(imageId) }, signal ? { signal } : {});
    let result;
    try {
      result = await services.llm.complete(
        {
          purpose: "image-puppet",
          messages: [
            { role: "system", content: PUPPET_SYSTEM },
            { role: "user", content: [{ type: "image", data: image.data, mime_type: image.mimeType }, { type: "text", text: PUPPET_INSTRUCTIONS }] },
          ],
          responseMode: "json",
          maxTokens: 24000,
          visionFallback: "fail",
        },
        signal ? { signal } : {},
      );
    } catch (error) {
      if (isAbortLike(error)) throw error;
      const rpc = toRpcError(error);
      if (rpc.detailCode === "ANALYZER_CONTENT_FILTERED" || (rpc.code !== "unsupported" && FILTERED.test(rpc.message))) return failed(imageId, "declined");
      throw error;
    }
    if (FILTERED.test(result.finishReason)) return failed(imageId, "declined");
    const cleaned = sanitizePuppetRig(result.parsed);
    if ("failure" in cleaned) {
      services.log.append("info", "puppet", `No rig for ${imageId}: ${cleaned.failure}`);
      return failed(imageId, cleaned.failure);
    }
    services.log.append("info", "puppet", `Rigged ${imageId}: ${cleaned.parts.map((p) => p.kind ?? p.label).join(", ")} (${result.model}, ${Math.round(result.latencyMs / 1000)} s)`);
    const at = now();
    return update(imageId, () => ({ imageId, status: "ready", enabled: true, rig: { version: 1, parts: cleaned.parts, model: result.model, createdAt: at }, updatedAt: at }));
  }

  return {
    async get(imageIds) {
      const ids = [...new Set(imageIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
      if (ids.length > PUPPET_GET_MAX_IDS) fail("bad-request", `At most ${PUPPET_GET_MAX_IDS} images per request.`);
      const states: Record<string, PuppetState> = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            states[id] = await read(needId(id));
          } catch (error) {
            services.log.append("warn", "puppet", `Unreadable puppet state ${id}: ${toRpcError(error).message}`);
            states[id] = emptyPuppetState(id);
          }
        }),
      );
      return states;
    },

    async rig(rawId, options = {}) {
      const imageId = needId(rawId);
      const running = inflight.get(imageId);
      if (running) return running;
      const task = (async () => {
        const current = await read(imageId);
        if (current.status === "ready" && !options.force) return update(imageId, (s) => ({ ...s, enabled: true, updatedAt: now() }));
        await acquire();
        try {
          return await runRig(imageId, options.signal);
        } finally {
          release();
        }
      })().finally(() => inflight.delete(imageId));
      inflight.set(imageId, task);
      return task;
    },

    async setEnabled(rawId, enabled) {
      const imageId = needId(rawId);
      const current = await read(imageId);
      if (current.status !== "ready") {
        if (enabled) fail("not-found", "This image has no animation rig yet.");
        return current;
      }
      return update(imageId, (s) => ({ ...s, enabled, updatedAt: now() }));
    },
  };
}
