/**
 * Continuity persistence in the chat (spec/pipeline.md §3.7a): checkpoints live in the chat store
 * (`messages[id].generations[*].continuity`), the current cum/injury actor state in a chat local-lore entry.
 * `readContinuityFromChat` / `writeContinuityToChat` reproduce the storage adapter of the 0.9.88 boot
 * (`U().getItem` / `setItem`, 180461-180536) by composing verbatim core functions.
 * AM 0.9.89 moved this storage into its own chat lore document (messages/jobs/currentActorState). The port keeps the
 * 0.9.88 format in userStorage, so the storage-only functions come from `storage-core.ts` (a 0.9.88 slice).
 */
import {
  rebuildContinuityFromChatStore as coreRebuild,
  rebuildContinuityAtMessage as coreRebuildAt,
  mergeLocalLoreActorState as coreMergeLore,
  toLocalLoreActorEntry as coreToEntry,
  applyActorStateEdit as coreApplyEdit,
  hi as messageIdOf,
} from "../core/asset-maid-core";
import {
  writeContinuityCheckpointsToChatStore as coreWriteStore,
  readContinuityCheckpointsFromChatStore as coreReadStore,
  readLocalLoreActorState as coreReadLore,
  writeLocalLoreActorState as coreWriteLore,
  hasContinuityData as coreHasData,
  EBe as coreCheckpointToStore,
  gR as LOCAL_LORE_ID,
} from "./storage-core";
import type {
  ActorContinuityState,
  ContinuityChat,
  ContinuityChatStore,
  ContinuityState,
  ContinuityMutator,
  LocalLoreActorEntry,
  LocalLoreActorState,
} from "./types";

/** Local-lore entry id "asset-maid:current-actor-state" (`gR`). */
export const CURRENT_ACTOR_STATE_LORE_ID: string = LOCAL_LORE_ID;

/** Write the state's checkpoints into `store.messages[*].generations[*].continuity` (clears old ones). Original: `NBe` @54505. */
export function writeContinuityCheckpointsToChatStore(store: ContinuityChatStore, state: ContinuityState | string, chatKey: string): void {
  coreWriteStore(store, state, chatKey);
}

/** All checkpoints found in the chat store as a state (`recentCheckpoints[chatKey]`). Original: `OBe` @54434. */
export function readContinuityCheckpointsFromChatStore(store: ContinuityChatStore, chatKey: string, messageIndexById: Map<string, number> = new Map()): ContinuityState {
  return coreReadStore(store, chatKey, messageIndexById) as ContinuityState;
}

/** Current state rebuilt from the newest checkpoint of the last 3 char messages. Original: `aoe` @54489. */
export function rebuildContinuityFromChatStore(store: ContinuityChatStore, chatKey: string, messages: unknown[]): ContinuityState {
  return coreRebuild(store, chatKey, messages) as ContinuityState;
}

/** State as of `messageId` (checkpoint of the nearest of the 3 previous messages), for history rebuilds. Original: `ooe` @54458. */
export function rebuildContinuityAtMessage(store: ContinuityChatStore, chatKey: string, messageIds: string[], messageId: string): ContinuityState {
  return coreRebuildAt(store, chatKey, messageIds, messageId) as ContinuityState;
}

/** Read the local-lore actor state (`{revision:0, actors:{}}` when absent or invalid). Original: `Wv` @52355. */
export function readLocalLoreActorState(chat: ContinuityChat): LocalLoreActorState {
  return coreReadLore(chat) as LocalLoreActorState;
}

/**
 * Upsert the local-lore entry (comment `__ASSET_MAID_CURRENT_ACTOR_STATE__`, content `@@dont_activate <json>`).
 * Mutates `chat.localLore`. Original: `Tne` @52403.
 */
export function writeLocalLoreActorState(chat: ContinuityChat, payload: LocalLoreActorState): void {
  coreWriteLore(chat, payload);
}

/** Merge local-lore actor entries into a characters map (ttl re-based on `_continuity_turn`). Original: `Lne` @52420. */
export function mergeLocalLoreActorState(characters: Record<string, ActorContinuityState>, payload: LocalLoreActorState): Record<string, ActorContinuityState> {
  return coreMergeLore(characters, payload) as Record<string, ActorContinuityState>;
}

/** Actor state -> local-lore entry (cum location + injury groups, count, remaining ttl). Original: `zne` @52340. */
export function toLocalLoreActorEntry(state: ActorContinuityState): LocalLoreActorEntry {
  return coreToEntry(state) as LocalLoreActorEntry;
}

/** Actor-state editor: keep only the selected tags; the count drops by the number of removed cum locations. Original: `Dne` @52431. */
export function applyActorStateEdit(entry: LocalLoreActorEntry, selected: Record<string, string[]>): LocalLoreActorEntry {
  return coreApplyEdit(entry, selected) as LocalLoreActorEntry;
}

/**
 * Storage adapter `getItem` (180470-180478): rebuild the state from the chat store, merge the local-lore actor
 * state, return null when the result is empty (`hasContinuityData`).
 */
export function readContinuityFromChat(store: ContinuityChatStore | null | undefined, chat: ContinuityChat, chatKey: string): ContinuityState | null {
  const state = rebuildContinuityFromChatStore(store ?? { messages: {} }, chatKey, Array.isArray(chat.message) ? chat.message : []);
  state.characters[chatKey] = mergeLocalLoreActorState(state.characters[chatKey] ?? {}, readLocalLoreActorState(chat)) as ContinuityState["characters"][string];
  return coreHasData(state) ? state : null;
}

/**
 * Storage adapter `setItem` (180489-180508): write checkpoints into the chat store, rebuild the actor entries from the
 * stored checkpoints and upsert the local-lore entry with `revision + 1`. Mutates `store` and `chat`.
 * Returns the written payload (the caller verifies it by reading back, as the original does).
 */
export function writeContinuityToChat(store: ContinuityChatStore, chat: ContinuityChat, state: ContinuityState | string, chatKey: string): LocalLoreActorState {
  writeContinuityCheckpointsToChatStore(store, state, chatKey);
  const indexById = new Map<string, number>(
    (Array.isArray(chat.message) ? chat.message : []).flatMap((message, index) => {
      const id = messageIdOf(message) as string;
      return id ? [[id, index] as [string, number]] : [];
    }),
  );
  const fromStore = readContinuityCheckpointsFromChatStore(store, chatKey, indexById);
  const current = readLocalLoreActorState(chat);
  const actors = { ...current.actors };
  for (const [key, value] of Object.entries(fromStore.characters[chatKey] ?? {})) actors[key] = toLocalLoreActorEntry(value);
  const payload = { revision: current.revision + 1, actors };
  writeLocalLoreActorState(chat, payload);
  return payload;
}

/** AM 0.9.89.5 `UF` @48353: actor keys that may be written to the current actor state (no role placeholders). */
function isPersistableActorKey(key: string): boolean {
  return !!key.trim() && key === key.trim() && !/^(?:primary|secondary|actor_\d+|female_\d+|male_\d+)$/u.test(key);
}

/** Outcome of {@link commitContinuityCheckpoint}. */
export type ContinuityCommitOutcome = "committed" | "skipped" | "already-committed";

/**
 * Commit one revision's continuity (AM 0.9.89.5 `gIe` 209058-209151). `basisRevision` is the actor-state revision the
 * run started from. A generation that already committed its state (`stateCommitRevision`) or skipped it never commits
 * again; when the actor state changed during the run the commit is skipped and marked (`stateCommitSkipped`), so a
 * user edit made meanwhile survives. Otherwise the checkpoint of `messageId`/`historyRevisionId` in `next` goes onto
 * that generation only (other generations keep theirs) and the next state's actors are merged over the current actor
 * state with `revision + 1`. Mutates `store` and `chat`.
 */
export function commitContinuityCheckpoint(
  store: ContinuityChatStore,
  chat: ContinuityChat,
  next: ContinuityState,
  chatKey: string,
  messageId: string,
  historyRevisionId: string,
  basisRevision: number,
): ContinuityCommitOutcome {
  const generation = store.messages[messageId]?.generations.find((g) => g.id === historyRevisionId);
  if (generation?.stateCommitRevision !== undefined || generation?.stateCommitSkipped === true) return "already-committed";
  const current = readLocalLoreActorState(chat);
  if (current.revision !== basisRevision) {
    if (generation) generation.stateCommitSkipped = true;
    return "skipped";
  }
  const checkpoint = next.recentCheckpoints[chatKey]?.find(
    (c) => c.messageId.replace(/^id:/u, "") === messageId && c.historyRevisionId === historyRevisionId,
  );
  const compact = checkpoint ? coreCheckpointToStore(checkpoint) : undefined;
  if (generation && compact) generation.continuity = compact;
  const actors = { ...current.actors };
  for (const [key, value] of Object.entries(next.characters[chatKey] ?? {}))
    if (isPersistableActorKey(key)) actors[key] = toLocalLoreActorEntry(value);
  const payload = { revision: current.revision + 1, actors };
  writeLocalLoreActorState(chat, payload);
  if (generation) generation.stateCommitRevision = payload.revision;
  return "committed";
}

/** Remove all continuity from a chat (`removeItem`, 180519-180530). */
export function clearContinuityFromChat(store: ContinuityChatStore, chat: ContinuityChat): void {
  for (const message of Object.values(store.messages)) for (const generation of message.generations) delete generation.continuity;
  chat.localLore = (Array.isArray(chat.localLore) ? chat.localLore : []).filter(
    (entry) => !(entry && typeof entry === "object" && (entry as { id?: unknown }).id === CURRENT_ACTOR_STATE_LORE_ID),
  );
}

/** Simple in-memory controller (`mutate` applies in place). The original debounced controller `pKe` is host-side. */
export function createMemoryContinuityController(initial: ContinuityState): ContinuityMutator & { state: ContinuityState } {
  return {
    state: initial,
    async mutate(fn) {
      fn(this.state);
    },
  };
}
