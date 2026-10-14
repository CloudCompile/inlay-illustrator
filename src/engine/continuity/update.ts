/**
 * Update after generation (spec/pipeline.md §3.7e).
 */
import {
  computeDeferredVisualContinuity as coreDeferred,
  updateModifierRefs as coreModifierRefs,
} from "../core/asset-maid-core";
import type { ContinuityState, VisualContinuityResult } from "./types";

export interface ContinuityUpdateInput {
  /** Result of `applyVisualContinuityToPlan` for this batch. */
  continuity: VisualContinuityResult;
  chatKey: string;
  chatIndex: number;
  messageIndex: number;
  /** `id:<messageId>`; unstable ids (`index:`, `request:`, `response-`) return an unchanged copy of the basis. */
  messageId: string;
  outfitReferences?: unknown[];
  /** Defaults to `amEnv.now()`. */
  now?: number;
}

/**
 * Continuity update for one generation, computed on a copy of `basisState`: characters (+stamp), modifier refs,
 * scene, NSFW positions, outfit refs and a checkpoint for `messageId` that is promoted to the current state.
 * Returns the new state; the caller persists it with the history revision commit. Original: `_Ye` (0.9.89.5 @74293;
 * replaces 0.9.88 `fKe` / `mKe`).
 */
export function computeDeferredVisualContinuity(
  input: ContinuityUpdateInput & { basisState: ContinuityState; historyRevisionId?: string; historyRevisionOrder?: number },
): ContinuityState {
  return coreDeferred(input) as ContinuityState;
}

/** Update `state.modifierRefs[chatKey]` (global onValue/onNone/clear; actor refs at the next turn). Original: `Ore` @48786. */
export function updateModifierRefs(
  state: ContinuityState,
  chatKey: string,
  continuity: VisualContinuityResult,
  now: number,
  chatIndex: number,
  messageIndex: number,
  messageId: string,
): void {
  coreModifierRefs(state, chatKey, continuity, now, chatIndex, messageIndex, messageId);
}
