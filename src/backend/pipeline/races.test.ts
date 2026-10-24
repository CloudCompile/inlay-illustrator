/**
 * Chat pipeline under concurrent use: busy locks, and message / swipe deletion while a run is in flight.
 */
import { describe, expect, test } from "bun:test";
import { createPipelineModule } from "./index.js";
import { CHAT_ID, createFakeEngine, createPipelineFixture, finished, waitFor } from "./testing/fixtures.js";

function setup(options: Parameters<typeof createPipelineFixture>[0] = {}) {
  const fx = createPipelineFixture(options);
  const engine = createFakeEngine();
  const { pipeline } = createPipelineModule(fx.services, undefined, { engine });
  return { fx, engine, pipeline };
}

const SWIPES = ["A one.\n\nA two.", "B one.\n\nB two.", "C one.\n\nC two."];

/** Engine gate that rejects with an AbortError when the run's signal aborts. */
const abortableGate = (_n: number, input: Record<string, unknown>) =>
  new Promise<void>((_resolve, reject) => (input.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

/** Host side of a swipe deletion: drop swipe `index` of m1, keep the active swipe on the shifted C. */
function hostDeleteSwipe(fx: ReturnType<typeof setup>["fx"], index: number) {
  const m = fx.fakeHost!.messages.get(CHAT_ID)!.find((x) => x.id === "m1")!;
  m.swipes.splice(index, 1);
  if (m.swipe_id > index) m.swipe_id -= 1;
  m.swipe_id = Math.min(m.swipe_id, m.swipes.length - 1);
  m.content = m.swipes[m.swipe_id]!;
}

describe("chat pipeline: races", () => {
  test("two concurrent generation.start calls for one message: the second is refused as busy", async () => {
    const { fx, engine, pipeline } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    engine.beforeImages = () => gate;
    const results = await Promise.allSettled([
      pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 0 }),
      pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 0 }),
    ]);
    await waitFor(() => engine.runs.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    const started = engine.runs.length;
    release();
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    await waitFor(() => finished(fx).length >= accepted);
    expect(accepted).toBe(1);
    expect(started).toBe(1);
  });

  test("one AI edit proposal applied twice at once starts one revision run", async () => {
    const { fx, engine, pipeline } = setup();
    await pipeline.handleGenerationEnded({ chatId: CHAT_ID, messageId: "m1", generationType: "normal" });
    await waitFor(() => finished(fx).length > 0);
    const slotId = "illustration:m1@0:slot:0";
    const entry = Object.values(fx.chatData.get(CHAT_ID)!.history.entriesById).find((e) => e.slotId === slotId)!;
    const { proposalId } = await pipeline.requestAiPromptEdit(CHAT_ID, slotId, entry.entryId, { instruction: "smile", imageToImage: false });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    engine.beforeImages = () => gate;
    const results = await Promise.allSettled([pipeline.applyAiPromptEdit(CHAT_ID, slotId, proposalId), pipeline.applyAiPromptEdit(CHAT_ID, slotId, proposalId)]);
    release();
    const accepted = results.filter((r) => r.status === "fulfilled").length;
    await waitFor(() => finished(fx).length >= 1 + accepted);
    expect(accepted).toBe(1);
  });

  test("swipe deletion during a run: the cancelled run does not write its plan over the shifted swipe's plan", async () => {
    const { fx, engine, pipeline } = setup({ messages: [{ id: "m1", swipes: SWIPES, swipe_id: 2 }] });
    // C (swipe 2) completes.
    const c = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 2 });
    await waitFor(() => finished(fx, c.jobId).length > 0);
    expect(fx.chatData.get(CHAT_ID)!.plans["illustration:m1@2"]!.status).toBe("complete");
    // B (swipe 1) fails once (plan B: status error).
    engine.beforeImages = () => {
      throw Object.assign(new Error("Provider rejected the prompt"), { retryable: false });
    };
    const b1 = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 1 });
    await waitFor(() => finished(fx, b1.jobId).length > 0);
    // B is retried and still running when the user deletes swipe B.
    engine.beforeImages = abortableGate;
    const runs = engine.runs.length;
    const b2 = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 1 });
    await waitFor(() => engine.runs.length > runs);
    hostDeleteSwipe(fx, 1);
    await pipeline.handleHostEvent("MESSAGE_SWIPED", { chatId: CHAT_ID, action: "deleted", swipeId: 1, message: { id: "m1", chat_id: CHAT_ID } });
    await waitFor(() => finished(fx, b2.jobId).length > 0);
    await new Promise((r) => setTimeout(r, 20));
    const doc = fx.chatData.get(CHAT_ID)!;
    // C now lives at m1@1 with its images; its plan must still be C's completed plan.
    expect(Object.keys(doc.history.messagesByKey)).toEqual(["illustration:m1@1"]);
    const plan = doc.plans["illustration:m1@1"]!;
    expect(plan.status).toBe("complete");
    expect(plan.error).toBe("");
  });

  test("message deletion during a run: the cancelled run does not re-create the deleted message's plan", async () => {
    const { fx, engine, pipeline } = setup();
    engine.beforeImages = abortableGate;
    const { jobId } = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 0 });
    await waitFor(() => engine.runs.length === 1);
    await pipeline.handleHostEvent("MESSAGE_DELETED", { chatId: CHAT_ID, messageId: "m1" });
    await waitFor(() => finished(fx, jobId).length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(fx.chatData.get(CHAT_ID)!.plans).toEqual({});
  });

  test("swipe deletion: the deleted swipe's in-memory error and failed job are not reported on the shifted swipe", async () => {
    const { fx, engine, pipeline } = setup({ messages: [{ id: "m1", swipes: SWIPES, swipe_id: 2 }] });
    const c = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 2 });
    await waitFor(() => finished(fx, c.jobId).length > 0);
    engine.beforeImages = () => {
      throw Object.assign(new Error("Provider rejected the prompt"), { retryable: false });
    };
    const b = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 1 });
    await waitFor(() => finished(fx, b.jobId).length > 0);
    engine.beforeImages = undefined;
    hostDeleteSwipe(fx, 1);
    await pipeline.handleHostEvent("MESSAGE_SWIPED", { chatId: CHAT_ID, action: "deleted", swipeId: 1, message: { id: "m1", chat_id: CHAT_ID } });
    // The active swipe is now C at index 1 (complete, no error).
    const state = (await pipeline.getMessageStates(CHAT_ID)).messages.find((m) => m.messageId === "m1")!;
    expect(state.swipeIndex).toBe(1);
    expect(fx.chatData.get(CHAT_ID)!.plans["illustration:m1@1"]!.status).toBe("complete");
    expect(state.lastError).toBeUndefined();
    expect(state.job?.jobId).not.toBe(b.jobId);
    // The deleted swipe's failed job is still offered for retry (messageKey m1@1); retry() then runs an
    // "illustration-retry" on C and adds a second revision to C.
    expect(pipeline.listActive(CHAT_ID).map((j) => j.jobId)).not.toContain(b.jobId);
  });

  test("swipe deletion: the deleted swipe's webtoon strip goes and later strips shift down", async () => {
    const { fx, pipeline } = setup({ messages: [{ id: "m1", swipes: SWIPES, swipe_id: 2 }] });
    const { createStripDocument, updateStrip, readStrip } = await import("../webtoon/store.js");
    // Swipe B (index 1) has a webtoon strip, swipe C (index 2) has none.
    await updateStrip(fx.services.storage, CHAT_ID, "m1@1", () => createStripDocument({ chatId: CHAT_ID, messageKey: "illustration:m1@1", historyId: "m1@1", characterId: "char-1", sourceLength: 14, now: 1 }));
    hostDeleteSwipe(fx, 1);
    await pipeline.handleHostEvent("MESSAGE_SWIPED", { chatId: CHAT_ID, action: "deleted", swipeId: 1, message: { id: "m1", chat_id: CHAT_ID } });
    // C is now m1@1: it has no strip.
    expect(await readStrip(fx.services.storage, CHAT_ID, "m1@1")).toBeNull();
    const state = (await pipeline.getMessageStates(CHAT_ID)).messages.find((m) => m.messageId === "m1")!;
    expect(state.webtoon).toBeUndefined();
  });

  test("swipe deletion keeps the generation records of a run committed meanwhile", async () => {
    const { fx, engine, pipeline } = setup({
      messages: [
        { id: "m1", swipes: SWIPES, swipe_id: 2 },
        { id: "u2", content: "Next.", is_user: true },
        { id: "m2", content: "Second reply one.\n\nSecond reply two." },
      ],
    });
    // A run on m2 is in progress (gated).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    engine.beforeImages = () => gate;
    const { jobId } = await pipeline.start({ chatId: CHAT_ID, messageId: "m2", swipeIndex: 0 });
    await waitFor(() => engine.runs.length === 1);
    // Sidecar IO of the swipe re-key step is slow (large sidecar).
    const storage = fx.services.storage as { updateJson: (path: string, fallback: unknown, mutate: (c: unknown) => unknown) => Promise<unknown> };
    const original = storage.updateJson.bind(storage);
    storage.updateJson = async (path, fallback, mutate) => {
      if (path.endsWith("pipeline.json") && fallback === null) await new Promise((r) => setTimeout(r, 50));
      return original(path, fallback, mutate);
    };
    // The user deletes swipe 1 of m1; the m2 run commits while the sidecar re-key runs.
    hostDeleteSwipe(fx, 1);
    const dropped = pipeline.handleHostEvent("MESSAGE_SWIPED", { chatId: CHAT_ID, action: "deleted", swipeId: 1, message: { id: "m1", chat_id: CHAT_ID } });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await waitFor(() => finished(fx, jobId).length > 0);
    await dropped;
    const doc = fx.chatData.get(CHAT_ID)!;
    const m2Entries = Object.values(doc.history.entriesById).filter((e) => e.slotId.startsWith("illustration:m2@0"));
    expect(m2Entries.length).toBeGreaterThan(0);
    const records = (fx.json.get("chats/chat-1/pipeline.json") as { records: Record<string, unknown> }).records;
    // Every committed m2 entry keeps its generation record (zoom prompts / single-slot regeneration need it).
    for (const e of m2Entries) expect(Object.keys(records)).toContain(e.entryId);
  });

  test("single-slot regeneration: a sidecar write failure after the History commit still completes and re-bakes", async () => {
    const { fx, engine, pipeline } = setup();
    engine.imageCount = 1;
    await pipeline.handleGenerationEnded({ chatId: CHAT_ID, messageId: "m1", generationType: "normal" });
    await waitFor(() => finished(fx).length > 0);
    const slotId = "illustration:m1@0:slot:0";
    const storage = fx.services.storage as { updateJson: (...a: unknown[]) => Promise<unknown> };
    const original = storage.updateJson.bind(storage);
    storage.updateJson = async (...args: unknown[]) => {
      if (String(args[0]).endsWith("pipeline.json")) throw new Error("storage write failed");
      return original(...args);
    };
    const { jobId } = await pipeline.regenerateSlot({ chatId: CHAT_ID, messageKey: "illustration:m1@0", slotId });
    await waitFor(() => finished(fx, jobId).length > 0);
    const doc = fx.chatData.get(CHAT_ID)!;
    const regen = Object.values(doc.history.entriesById).find((e) => e.generationOrigin === "regenerate")!;
    // History committed the new entry as the slot's default ...
    expect(regen).toBeDefined();
    expect(doc.history.messagesByKey["illustration:m1@0"]!.revisions[0]!.slotsById[slotId]!.defaultEntryId).toBe(regen.entryId);
    // ... so the run must report completed and the message must show it (like the message run path, which only logs).
    expect(finished(fx, jobId)[0]!.result).toBe("completed");
    expect(fx.message("m1").content).toContain(`data-inlay-illustrator-image-id="${regen.savedPath!.split("/").pop()}"`);
  });
});
