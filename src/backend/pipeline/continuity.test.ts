import { describe, expect, test } from "bun:test";
import {
  commitContinuityCheckpoint,
  createEmptyContinuityState,
  pushContinuityCheckpoint,
  readLocalLoreActorState,
  rebuildContinuityAtMessage,
  writeLocalLoreActorState,
  type ContinuityChatStore,
  type ContinuityState,
} from "../../engine/continuity/index.js";
import { continuityLookbackIds } from "./generate.js";
import type { ChatMessageView } from "./host-chat.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const chatKey = "chat:c1";
const checkpoint = (tag: string) => ({ scene: { backgroundTags: [tag], locationTags: [] }, characters: {}, participants: { characterKeys: [], personaKeys: [] } });
const generation = (id: string, tag?: string) => ({ id, targetCount: 1, slots: { "0": [{ assetName: id }] }, ...(tag ? { continuity: checkpoint(tag) } : {}) });

function nextState(messageId: string, revisionId: string, messageIndex: number): ContinuityState {
  const next = createEmptyContinuityState();
  next.scenes[chatKey] = { backgroundTags: ["five"], locationTags: [], updatedAt: 1, updatedAtChatIndex: 0, updatedAtMessageIndex: messageIndex } as never;
  next.characters[chatKey] = { alice: { cum_count: 0 }, primary: { cum_count: 0 } } as never;
  pushContinuityCheckpoint(next, {
    chatKey,
    messageId: `id:${messageId}`,
    messageIndex,
    historyRevisionId: revisionId,
    historyRevisionOrder: 0,
    capturedAt: 6000,
    participants: { characterKeys: [], personaKeys: [] },
  } as never);
  return next;
}

describe("continuity commit (AM gIe)", () => {
  test("writes only the committed revision's checkpoint and keeps the others", () => {
    const store: any = {
      messages: {
        "m1@0": { kind: "illustration", generations: [generation("r1", "one")] },
        "m3@0": { kind: "illustration", generations: [generation("r3a", "three"), generation("r3b", "three-b")] },
        "m5@0": { kind: "illustration", generations: [generation("r5")] },
      },
    };
    const chat: any = { message: [], localLore: [] };
    expect(commitContinuityCheckpoint(store as ContinuityChatStore, chat, nextState("m5@0", "r5", 5), chatKey, "m5@0", "r5", 0)).toBe("committed");
    expect(store.messages["m1@0"].generations[0].continuity.scene.backgroundTags).toEqual(["one"]);
    expect(store.messages["m3@0"].generations.map((g: any) => g.continuity.scene.backgroundTags[0])).toEqual(["three", "three-b"]);
    expect(store.messages["m5@0"].generations[0].continuity.scene.backgroundTags).toEqual(["five"]);
    const state = readLocalLoreActorState(chat);
    expect(state.revision).toBe(1);
    expect(Object.keys(state.actors)).toEqual(["alice"]);
    expect(store.messages["m5@0"].generations[0].stateCommitRevision).toBe(1);
  });

  test("a revision commits its state once; a later commit of the same revision writes nothing", () => {
    const store: any = { messages: { "m5@0": { kind: "illustration", generations: [generation("r5")] } } };
    const chat: any = { message: [], localLore: [] };
    expect(commitContinuityCheckpoint(store, chat, nextState("m5@0", "r5", 5), chatKey, "m5@0", "r5", 0)).toBe("committed");
    expect(commitContinuityCheckpoint(store, chat, nextState("m5@0", "r5", 5), chatKey, "m5@0", "r5", 1)).toBe("already-committed");
    expect(readLocalLoreActorState(chat).revision).toBe(1);
  });

  test("an actor state edited during the run is kept: the commit is skipped and marked", () => {
    const store: any = { messages: { "m3@0": { kind: "illustration", generations: [generation("r3")] }, "m5@0": { kind: "illustration", generations: [generation("r5")] } } };
    const chat: any = { message: [], localLore: [] };
    commitContinuityCheckpoint(store, chat, nextState("m3@0", "r3", 3), chatKey, "m3@0", "r3", 0);
    // The user edits the chat state (revision 1 -> 2) while the next run, started from revision 1, is still going.
    const edited = readLocalLoreActorState(chat);
    writeLocalLoreActorState(chat, { revision: 2, actors: { renamed: edited.actors.alice! } });
    expect(commitContinuityCheckpoint(store, chat, nextState("m5@0", "r5", 5), chatKey, "m5@0", "r5", 1)).toBe("skipped");
    expect(readLocalLoreActorState(chat)).toMatchObject({ revision: 2 });
    expect(Object.keys(readLocalLoreActorState(chat).actors)).toEqual(["renamed"]);
    expect(store.messages["m5@0"].generations[0].continuity).toBeUndefined();
    expect(store.messages["m5@0"].generations[0].stateCommitSkipped).toBe(true);
  });
});

describe("continuity lookback ids (AM cPt)", () => {
  const view = (id: string, role: "user" | "assistant"): ChatMessageView => ({ id, swipeId: 0, role, content: "x" }) as unknown as ChatMessageView;
  const messages = [view("m0", "user"), view("m1", "assistant"), view("m2", "user"), view("m3", "assistant"), view("m4", "user"), view("m5", "assistant"), view("m6", "user"), view("m7", "assistant")];

  test("only assistant messages carry an id", () => {
    expect(continuityLookbackIds(messages, 7, "m7@0")).toEqual(["", "m1@0", "", "m3@0", "", "m5@0", "", "m7@0"]);
  });

  test("the 3-message lookback reaches the assistant reply before an unillustrated one", () => {
    const store: any = {
      messages: {
        "m3@0": { kind: "illustration", generations: [generation("r3", "three")] },
      },
    };
    const state = rebuildContinuityAtMessage(store, chatKey, continuityLookbackIds(messages, 7, "m7@0"), "m7@0");
    expect(state.recentCheckpoints[chatKey]?.length).toBe(1);
  });
});
