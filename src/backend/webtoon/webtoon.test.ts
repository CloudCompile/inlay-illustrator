import { describe, expect, test } from "bun:test";
import { createPipelineModule } from "../pipeline/index.js";
import { CHAT_ID, createFakeEngine, createPipelineFixture, finished, STORY, waitFor } from "../pipeline/testing/fixtures.js";
import { rerollWebtoonPanel } from "./run.js";
import { readStrip, webtoonPath } from "./store.js";

const shot = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "image",
  beat: "dialogue",
  size: "832x1216",
  layout: "full_width",
  nai: { base: "upper body, school gate, morning\nShe waves.", characters: [{ name: "Shouta", x: 0.7, y: 0.7, framing: "cowboy shot", prompt: "running, looking at viewer\nHe runs." }] },
  text: [],
  ...extra,
});

const STORYBOARD = {
  title: "Chapter 1: Late Again",
  outfits: [{ name: "Shouta", outfit_id: "o2" }],
  panels: [
    shot(1, { layout: "title", beat: "title" }),
    shot(2, { text: [{ type: "speech", speaker: "Alice", text: "You're late again!", anchor: "top-left" }, { type: "speech", speaker: "Shouta", text: "I overslept, sorry.", anchor: "top-right" }] }),
    shot(3, { size: "1472x704", layout: "wide_band", beat: "insert", nai: { base: "close-up, hand, sleeve", characters: [] } }),
    { id: 4, kind: "text_beat", beat: "quiet", text: [{ type: "narration", text: "Mr. Bob watched them from the window." }] },
    shot(5, { beat: "action", text: [{ type: "sfx", text: "tug", anchor: "bottom-left" }] }),
    shot(6, { layout: "inset_right" }),
    shot(7, { layout: "fade_white" }),
  ],
};

async function setup() {
  const fx = createPipelineFixture({ config: { image: { provider: "novelai", model: "nai-diffusion-5-full", connectionId: "img-1" }, novelai: { analysisProfile: "v5-hybrid" }, runtime: { generationAutoRetryCount: 0 } } });
  await fx.services.storage.updateConfig((config) => {
    const profiles = { ...config.characterPrompt.personaSettings.profiles } as Record<string, unknown>;
    profiles["persona-1"] = {
      forms: {
        defaultFormId: "form_default",
        forms: [
          {
            id: "form_default", label: "black hair, tall", description: "", humanlike: true, gender: "male", basePromptGroups: { "hair.color": ["black hair"] }, negativePrompt: "", reference: null, defaultOutfitId: "o1",
            outfits: [
              { id: "o1", label: "Hoodie", description: "", candidateEnabled: true, head: "", top: "grey hoodie", bottom: "jeans", legs: "", feet: "" },
              { id: "o2", label: "Uniform", description: "", candidateEnabled: true, head: "", top: "gakuran", bottom: "black pants", legs: "", feet: "loafers" },
            ],
          },
        ],
      },
    };
    return { ...config, characterPrompt: { ...config.characterPrompt, personaSettings: { ...config.characterPrompt.personaSettings, profiles } } } as typeof config;
  });
  const settings = await fx.services.storage.loadChatImageGenerationSettings();
  await fx.services.storage.saveChatImageGenerationSettings({ ...settings, webtoonMode: true });
  const engine = createFakeEngine();
  const { pipeline } = createPipelineModule(fx.services, undefined, { engine });
  return { fx, engine, pipeline };
}

describe("webtoon mode (controller over a fake engine)", () => {
  test("planner -> validated storyboard -> one coordinate request per image panel -> stored strip, no inline bake", async () => {
    const { fx, engine, pipeline } = await setup();
    fx.llmReplies.push(STORYBOARD);
    const { jobId } = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 0 });
    await waitFor(() => finished(fx, jobId).length > 0);
    expect(finished(fx, jobId)[0]!.result).toBe("completed");
    expect(engine.runs.length).toBe(0);
    const planner = fx.llmRequests[0]!;
    expect(planner.purpose).toBe("webtoon-planner");
    const prompt = String(planner.messages[0]!.content);
    expect(prompt).toContain('- Shouta (man/boy): black hair, tall; wardrobe: o1 (current) = "Hoodie" (items: top: grey hoodie; bottom: jeans); o2 = "Uniform" (items: top: gakuran; bottom: black pants; feet: loafers).');
    expect(prompt).not.toContain("black hair, male");
    expect(engine.dispatches.length).toBe(6);
    const first = engine.dispatches[1]!.request as Record<string, any>;
    expect(first.prompt).toMatch(/^1boy, /u);
    expect(first.config.useCoords).toBe(true);
    expect(first.config.forceCharacterCoordinates).toBe(true);
    expect(first.config.characterPrompts).toEqual([{ prompt: "male, 1.1::black hair::, running, looking at viewer, 1.2::gakuran::, black pants\nHe runs.", uc: "", centerX: 0.7, centerY: 0.7, coordinateMode: "fixed" }]);
    expect(String(first.negativePrompt)).toContain("speech bubble, text");
    expect((engine.dispatches[2]!.request as Record<string, any>).prompt).toMatch(/^no humans, /u);

    const strip = (await readStrip(fx.services.storage, CHAT_ID, "m1@0"))!;
    expect(fx.json.has(webtoonPath(CHAT_ID, "m1@0"))).toBe(true);
    expect(strip.status).toBe("complete");
    expect(strip.cast).toEqual([{ name: "Shouta", key: "persona::persona-1", outfitId: "o2" }]);
    expect(Object.values(strip.panels).map((p) => [p.status, p.takes.length, p.selected])).toEqual(Array(6).fill(["done", 1, 0]));
    const layout = (await pipeline.getWebtoon(CHAT_ID, "illustration:m1@0")).strip!.layout!;
    expect([layout.width, layout.panels.length]).toEqual([690, 6]);
    expect(layout.items.map((i) => (i.kind === "title" ? `title:${i.big}` : i.text))).toEqual(["title:Late Again", "You're late again!", "Mr. Bob watched them from the window.", "tug"]);
    expect(strip.validation!.log.some((l) => l.includes("I overslept"))).toBe(true);
    expect(fx.message("m1").content).toBe(STORY);

    const [state] = (await pipeline.getMessageStates(CHAT_ID, ["m1"])).messages;
    expect(state!.webtoon).toEqual({ revision: strip.revision, status: "complete" });
    pipeline.dispose();
  });

  test("reroll adds a take as a regenerate job; older takes can be shown again; text edits re-lay out the strip", async () => {
    const { fx, engine, pipeline } = await setup();
    fx.llmReplies.push(STORYBOARD);
    const run = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 0 });
    await waitFor(() => finished(fx, run.jobId).length > 0);
    const { jobId } = await pipeline.rerollWebtoonPanel(CHAT_ID, "illustration:m1@0", "2");
    await waitFor(() => finished(fx, jobId).length > 0);
    expect(finished(fx, jobId)[0]!.result).toBe("completed");
    expect(engine.dispatches.length).toBe(7);
    const progress = fx.events.find((e) => e.event === "generation.progress" && (e.payload as { jobId: string }).jobId === jobId)!.payload as { slotId?: string; attemptKind: string };
    expect([progress.slotId, progress.attemptKind]).toEqual(["webtoon:2", "regenerate"]);
    const view = (await pipeline.getWebtoon(CHAT_ID, "illustration:m1@0")).strip!;
    expect(view.panels["2"]!.takes.length).toBe(2);
    expect(view.panels["2"]!.selected).toBe(1);
    const back = (await pipeline.selectWebtoonTake({ chatId: CHAT_ID, messageKey: "illustration:m1@0", panelId: "2", take: 0, width: 450 })).strip;
    expect([back.panels["2"]!.selected, back.layout!.width]).toEqual([0, 450]);
    expect((await readStrip(fx.services.storage, CHAT_ID, "m1@0"))!.panels["2"]!.selected).toBe(0);
    await expect(pipeline.selectWebtoonTake({ chatId: CHAT_ID, messageKey: "illustration:m1@0", panelId: "2", take: 2 })).rejects.toThrow();

    const edited = (await pipeline.editWebtoonText({ chatId: CHAT_ID, messageKey: "illustration:m1@0", panelId: "2", textIndex: 0, text: "Late. Again." })).strip;
    const balloon = (s: typeof edited) => s.layout!.items.flatMap((i) => (i.kind === "speech" ? [i.text] : []))[0];
    expect(balloon(edited)).toBe("Late. Again.");
    expect(edited.revision).toBeGreaterThan(back.revision);
    const reverted = (await pipeline.editWebtoonText({ chatId: CHAT_ID, messageKey: "illustration:m1@0", panelId: "2", textIndex: 0, text: "You're late again!" })).strip;
    expect(balloon(reverted)).toBe("You're late again!");
    expect((await readStrip(fx.services.storage, CHAT_ID, "m1@0"))!.textOverrides).toEqual({});
    pipeline.dispose();
  });

  test("a panel waits while NovelAI reports a concurrent generation (429 lock)", async () => {
    const { fx, engine, pipeline } = await setup();
    fx.llmReplies.push(STORYBOARD);
    const run = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 0 });
    await waitFor(() => finished(fx, run.jobId).length > 0);
    const dispatch = engine.dispatch.bind(engine);
    let locked = 2;
    engine.dispatch = async (...args) => {
      if (locked-- > 0) throw new Error("NovelAI image generate failed (429): Concurrent generation is locked");
      return dispatch(...args);
    };
    const config = await fx.services.storage.loadConfig();
    const view = await rerollWebtoonPanel({ services: fx.services, engine, lockWaitMs: 1 }, { chatId: CHAT_ID, historyId: "m1@0", panelId: "3", config, signal: new AbortController().signal, onChanged: () => {} });
    expect(view.panels["3"]!.takes.length).toBe(2);
    expect(locked).toBe(-1);
    pipeline.dispose();
  });

  test("a planner without a usable storyboard fails the job after 3 calls", async () => {
    const { fx, engine, pipeline } = await setup();
    fx.llmReplies.push({ panels: [] }, { panels: [] }, new Error("boom"));
    const { jobId } = await pipeline.start({ chatId: CHAT_ID, messageId: "m1", swipeIndex: 0 });
    await waitFor(() => finished(fx, jobId).length > 0);
    expect(finished(fx, jobId)[0]!.result).toBe("failed");
    expect(fx.llmRequests.length).toBe(3);
    expect(engine.dispatches.length).toBe(0);
    const strip = (await readStrip(fx.services.storage, CHAT_ID, "m1@0"))!;
    expect(strip.status).toBe("error");
    expect(strip.planner!.calls.map((c) => c.hardOk)).toEqual([false, false, false]);
    pipeline.dispose();
  });
});
