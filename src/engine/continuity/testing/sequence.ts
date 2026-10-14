/**
 * Parity driver for v4-5 visual continuity sequences. The SAME driver runs in the fixture generator (ORIGINAL bundle
 * functions via `__AM_eval`) and in the bun tests (port exports).
 *
 * Per turn (0.9.88 names; 0.9.89.5 names in the fixture generator):
 *   context     buildVisualContinuityContext(state, chatKey, [primaryKey, secondaryKey], ...)   NAt
 *   apply       applyVisualContinuityToPlan(plan, ruleRuntime, {previousCharacterStateMap, ...}) z9e
 *   update      state = computeDeferredVisualContinuity({basisState: state, ...})               0.9.89.5 `_Ye`
 *               (0.9.89 dropped the in-place update `fKe` and the checkpoint reconcile `Pte`)
 *   storage     setItem: writeContinuityCheckpointsToChatStore (NBe) + readContinuityCheckpointsFromChatStore (OBe)
 *               + toLocalLoreActorEntry (zne) + writeLocalLoreActorState (Tne)
 *               getItem: rebuildContinuityFromChatStore (aoe) + mergeLocalLoreActorState (Lne) + readLocalLoreActorState (Wv)
 *               NBe / OBe / Tne / Wv are the 0.9.88 storage bridge (`storage-core.ts`; the generator loads the 0.9.88 bundle for them).
 *   v5 basis    createV5ContinuityBasis(getLatestContinuityCheckpointSnapshot(state, chatKey, "novelai-v5"))  vN / D5e
 */
import { toPlain } from "../../testing/plain";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Fn = (...args: any[]) => any;

export interface ContinuityCoreFns {
  createV45RuleRuntime: Fn; // DLe
  createEmptyContinuityState: Fn; // $g
  applyVisualContinuityToPlan: Fn; // z9e
  computeDeferredVisualContinuity: Fn; // _Ye (0.9.89.5)
  buildVisualContinuityContext: Fn; // NAt
  writeContinuityCheckpointsToChatStore: Fn; // NBe
  readContinuityCheckpointsFromChatStore: Fn; // OBe
  rebuildContinuityFromChatStore: Fn; // aoe
  rebuildContinuityAtMessage: Fn; // ooe
  readLocalLoreActorState: Fn; // Wv
  writeLocalLoreActorState: Fn; // Tne
  mergeLocalLoreActorState: Fn; // Lne
  toLocalLoreActorEntry: Fn; // zne
  getLatestContinuityCheckpointSnapshot: Fn; // D5e
  createV5ContinuityBasis: Fn; // vN
  stripAccumulationState: Fn; // TA
}

export interface ContinuityTurn {
  plan: { images: Array<Record<string, any>>; [key: string]: unknown };
  messageId: string;
  messageIndex: number;
  chatIndex?: number;
  advanceTurn?: boolean;
  /** "none" skips the update; "live" and "deferred" both run `_Ye` since 0.9.89 (kept so the recorded sequences stay readable). */
  mode: "live" | "deferred" | "none";
  historyRevisionId?: string;
  historyRevisionOrder?: number;
  outfitReferences?: unknown[];
  /** Run the storage round trip (setItem then getItem) after the turn. */
  storageRoundTrip?: boolean;
}

export interface ContinuitySequence {
  name: string;
  seed: number;
  chatKey: string;
  stateAccumulationEnabled?: boolean;
  turns: ContinuityTurn[];
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export async function runContinuitySequence(fns: ContinuityCoreFns, seq: ContinuitySequence): Promise<unknown[]> {
  const rt = fns.createV45RuleRuntime();
  let state: any = fns.createEmptyContinuityState();
  const chat: any = { message: [], localLore: [] };
  const store: any = { messages: {} };
  const out: unknown[] = [];
  const ck = seq.chatKey;
  for (const [index, turn] of seq.turns.entries()) {
    const rec: Record<string, unknown> = { turn: index };
    const plan = clone(turn.plan);
    const first = plan.images[0] ?? {};
    const keyOf = (slot: string) => String(first.actors?.[slot]?.lorebook_prompt_key ?? "");
    rec.context = fns.buildVisualContinuityContext(
      state,
      ck,
      [keyOf("primary"), keyOf("secondary")].filter(Boolean),
      ["lore:alice", "lore:bob"],
      ["persona::p1"],
      {},
    );
    if (seq.stateAccumulationEnabled === false) rec.strippedContext = fns.stripAccumulationState(rec.context);
    const continuity = fns.applyVisualContinuityToPlan(plan, rt, {
      previousCharacterStateMap: state.characters[ck] ?? {},
      previousGlobalModifierRefs: state.modifierRefs[ck]?.global ?? {},
      advanceTurn: turn.advanceTurn,
      stateAccumulationEnabled: seq.stateAccumulationEnabled,
    });
    rec.apply = {
      characterStates: continuity.characterStates,
      imageActorStates: continuity.imageActorStates,
      imagePromptSelections: continuity.imagePromptSelections,
      nsfwSourceImageTokens: continuity.nsfwSourceImageTokens,
      modifiers: continuity.plan.images.map((i: any) => i.modifiers),
    };
    if (turn.mode !== "none")
      state = fns.computeDeferredVisualContinuity({
        continuity,
        chatKey: ck,
        chatIndex: turn.chatIndex ?? 0,
        messageIndex: turn.messageIndex,
        messageId: turn.messageId,
        outfitReferences: turn.outfitReferences ?? [],
        basisState: state,
        historyRevisionId: turn.historyRevisionId,
        historyRevisionOrder: turn.historyRevisionOrder,
      });
    // keep a chat transcript + chat-store generation per message (shape read by aoe / NBe)
    const rawId = String(turn.messageId).replace(/^id:/u, "");
    if (!chat.message.some((m: any) => m.chatId === rawId)) chat.message.push({ role: "char", data: `message ${rawId}`, chatId: rawId });
    store.messages[rawId] ??= { generations: [] };
    const gens = store.messages[rawId].generations;
    gens.push({ id: turn.historyRevisionId ?? `gen-${index}`, slots: { "0": [{ assetName: `img-${index}` }] } });
    if (turn.storageRoundTrip) {
      // setItem (180489-180508)
      fns.writeContinuityCheckpointsToChatStore(store, state, ck);
      const indexById = new Map<string, number>(chat.message.map((m: any, i: number) => [m.chatId, i]));
      const fromStore = fns.readContinuityCheckpointsFromChatStore(store, ck, indexById);
      const lore = fns.readLocalLoreActorState(chat);
      const actors = { ...lore.actors };
      for (const [key, value] of Object.entries(fromStore.characters[ck] ?? {})) actors[key] = fns.toLocalLoreActorEntry(value);
      fns.writeLocalLoreActorState(chat, { revision: lore.revision + 1, actors });
      // getItem (180470-180478)
      const rebuilt = fns.rebuildContinuityFromChatStore(store, ck, chat.message);
      rebuilt.characters[ck] = fns.mergeLocalLoreActorState(rebuilt.characters[ck] ?? {}, fns.readLocalLoreActorState(chat));
      rec.storage = { store: clone(store), localLore: clone(chat.localLore), rebuilt };
      rec.rebuiltAtMessage = fns.rebuildContinuityAtMessage(store, ck, chat.message.map((m: any) => m.chatId), rawId);
    }
    rec.v5Basis = fns.createV5ContinuityBasis(fns.getLatestContinuityCheckpointSnapshot(state, ck, "novelai-v5"));
    rec.v5BasisFromCharacters = fns.createV5ContinuityBasis({ characters: state.characters[ck] ?? {} });
    rec.state = clone(toPlain(state));
    out.push(toPlain(rec));
  }
  return out;
}
