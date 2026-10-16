import { describe, expect, test } from "bun:test";
import { createPipelineModule } from "../pipeline/index.js";
import { CHAT_ID, CHARACTER_ID, createFakeEngine, createPipelineFixture, finished, waitFor } from "../pipeline/testing/fixtures.js";
import { appearanceText } from "./looks.js";
import { readStrip } from "./store.js";

const CARD = [
  "### Basic Information",
  "Name: {{char}}",
  "Occupation: Part-time worker at a convenience store",
  "",
  "### Appearance",
  "- Height & Build: About 160cm, average build",
  "- Figure Details: D-cup breasts",
  "- Skin: Very pale and fair",
  "- Hairstyle: Long black hair in a hime cut with blunt bangs",
  "",
  "### Personality",
  "- Extremely timid",
].join("\n");

const M1 = 'She stacked onigiri on the shelf.\n\n"Welcome," she mumbled when Shouta came in. The store manager frowned at her from the register.';
const M2 = '"Same as yesterday?" she asked, not looking up. Shouta nodded.';

const SHOUTA_FORMS = {
  defaultFormId: "form_default",
  forms: [
    {
      id: "form_default", label: "black hair, tall", description: "", humanlike: true, gender: "male", basePromptGroups: { "hair.color": ["black hair"] }, negativePrompt: "", reference: null, defaultOutfitId: "o1",
      outfits: [{ id: "o1", label: "Hoodie", description: "", candidateEnabled: true, head: "", top: "grey hoodie", bottom: "jeans", legs: "", feet: "" }],
    },
  ],
};

const panel = (id: number, names: string[]) => ({
  id, kind: "image", beat: "dialogue", size: "832x1216", layout: "full_width",
  nai: { base: "upper body, indoors, convenience store\nThe shop.", characters: names.map((name, i) => ({ name, x: i ? 0.7 : 0.3, y: 0.5, framing: "upper body", prompt: "standing\nShe stands." })) },
  text: [],
});
const MIYOKO_LOOK = { name: "Miyoko", gender: "female", identity: "long hair, black hair, hime cut, blunt bangs, pale skin, large breasts, shouta", outfit: { label: "Tracksuit", top: "blue track jacket", bottom: "blue track pants", feet: "sneakers" } };
const board = (looks: unknown[], names = ["Miyoko", "Shouta"]) => ({ title: "Shift", outfits: [], looks, panels: [1, 2, 3, 4].map((id) => panel(id, names)) });

async function setup(options: { personaAnalysed?: boolean; freeCharacters?: boolean } = {}) {
  const fx = createPipelineFixture({
    config: { image: { provider: "novelai", model: "nai-diffusion-5-full", connectionId: "img-1" }, novelai: { analysisProfile: "v5-hybrid" }, runtime: { generationAutoRetryCount: 0 } },
    messages: [
      { id: "u1", content: "I walk in.", is_user: true },
      { id: "m1", content: M1 },
      { id: "u2", content: "I buy coffee.", is_user: true },
      { id: "m2", content: M2 },
    ],
  });
  Object.assign(fx.characters[0]!, { name: "Miyoko", description: CARD });
  const analyse = (on: boolean) =>
    fx.services.storage.updateConfig((config) => {
      const profiles = { ...config.characterPrompt.personaSettings.profiles } as Record<string, unknown>;
      if (on) profiles["persona-1"] = { forms: SHOUTA_FORMS };
      else delete profiles["persona-1"];
      const defaults = { ...config.characterPrompt.charxGenerationDefaults, freeCharacterGeneration: options.freeCharacters ?? false };
      return { ...config, characterPrompt: { ...config.characterPrompt, charxGenerationDefaults: defaults, personaSettings: { ...config.characterPrompt.personaSettings, profiles } } } as typeof config;
    });
  await analyse(options.personaAnalysed ?? true);
  const settings = await fx.services.storage.loadChatImageGenerationSettings();
  await fx.services.storage.saveChatImageGenerationSettings({ ...settings, webtoonMode: true });
  const engine = createFakeEngine();
  const { pipeline } = createPipelineModule(fx.services, undefined, { engine });
  const run = async (messageId: string, reply: unknown) => {
    fx.llmReplies.push(reply);
    const before = engine.dispatches.length;
    const { jobId } = await pipeline.start({ chatId: CHAT_ID, messageId, swipeIndex: 0 });
    await waitFor(() => finished(fx, jobId).length > 0);
    expect(finished(fx, jobId)[0]!.result).toBe("completed");
    const prompts = engine.dispatches.slice(before).map((d) => ((d.request as { config: { characterPrompts: Array<{ prompt: string }> } }).config.characterPrompts).map((c) => c.prompt));
    return { prompt: String(fx.llmRequests.at(-1)!.messages[0]!.content), prompts, strip: (await readStrip(fx.services.storage, CHAT_ID, `${messageId}@0`))! };
  };
  return { fx, pipeline, run, analyse };
}

const MIYOKO_ID = "female, long hair, 1.1::black hair::, blunt bangs, hime cut, pale skin";

describe("webtoon looks of characters without an analysis", () => {
  test("appearance text: the Appearance section, explicit lines dropped, macros filled", () => {
    expect(appearanceText(CARD, { char: "Miyoko", user: "Shouta" })).toBe("### Appearance\n- Height & Build: About 160cm, average build\n- Skin: Very pale and fair\n- Hairstyle: Long black hair in a hime cut with blunt bangs");
    expect(appearanceText("{{char}} is a tall knight.\nShe likes {{user}}.", { char: "Ann", user: "Bo" })).toBe("Ann is a tall knight.\nShe likes Bo.");
  });

  test("the speaking character joins unnamed, the planner's look goes into every panel, the next strip keeps it", async () => {
    const { pipeline, run } = await setup();
    const first = await run("m2", board([MIYOKO_LOOK]));
    expect(first.prompt).toContain("- Miyoko (character): no design yet. Appearance from the card:\n<<<\n### Appearance\n- Height & Build: About 160cm, average build\n- Skin: Very pale and fair\n- Hairstyle: Long black hair in a hime cut with blunt bangs\n>>>");
    expect(first.prompt).not.toContain("D-cup");
    expect(first.prompt).toContain('- Shouta (man/boy): black hair, tall; wardrobe: o1 (current)');
    expect(first.prompts.length).toBe(4);
    for (const p of first.prompts) {
      expect(p[0]!.startsWith(`${MIYOKO_ID}, standing`)).toBe(true);
      expect(p[0]).toContain("blue track jacket");
      expect(p[0]).not.toContain("breasts");
      expect(p[0]).not.toContain("shouta");
      expect(p[1]!.startsWith("male, 1.1::black hair::, standing")).toBe(true);
    }
    const miyoko = first.strip.cast.find((c) => c.name === "Miyoko")!;
    expect(miyoko).toMatchObject({ key: CHARACTER_ID, gender: "female", outfitId: "look_1", look: { identity: "female, long hair, black hair, hime cut, blunt bangs, pale skin", outfitLabel: "Tracksuit" } });

    const second = await run("m1", board([]));
    expect(second.prompt).toContain('- Miyoko (woman/girl): designed earlier; wardrobe: look_1 (current) = "Tracksuit" (items: top: blue track jacket; bottom: blue track pants; feet: sneakers).');
    expect(second.prompts.every((p) => p[0]!.startsWith(`${MIYOKO_ID}, standing`) && p[0]!.includes("blue track jacket"))).toBe(true);
    expect(second.strip.cast.find((c) => c.name === "Miyoko")!.look!.identity).toBe(miyoko.look!.identity);
    pipeline.dispose();
  });

  test("an analysis wins over a look written by the planner", async () => {
    const { pipeline, run, analyse } = await setup({ personaAnalysed: false });
    const first = await run("m2", board([MIYOKO_LOOK, { name: "Shouta", gender: "male", identity: "brown hair, short hair", outfit: { label: "Suit", top: "black jacket" } }]));
    expect(first.prompt).toContain("- Shouta (character): no design yet.");
    expect(first.prompts[0]![1]).toStartWith("male, 1.1::brown hair::, short hair, standing");
    await analyse(true);
    const second = await run("m1", board([]));
    expect(second.prompt).toContain('- Shouta (man/boy): black hair, tall; wardrobe: o1 (current)');
    expect(second.prompts[0]![1]!.startsWith("male, 1.1::black hair::, standing")).toBe(true);
    pipeline.dispose();
  });

  test("free character generation: on -> a story character joins through autoCharacter as a custom character; off -> no new characters", async () => {
    const manager = { name: "Store Manager", gender: "male", identity: "short hair, grey hair, glasses, wrinkled skin", outfit: { label: "Uniform", top: "store uniform, name tag", bottom: "black pants" } };
    const on = await setup({ freeCharacters: true });
    const a = await run3(on, manager);
    expect(a.prompt).toContain('for each person the reply shows who is NOT listed above');
    const doc = await on.fx.services.storage.loadCharacterDocument(CHARACTER_ID);
    const created = doc.customCharacters.find((c) => c.title === "Store Manager")!;
    expect(created.origin).toBe("ai-auto");
    expect(Object.keys(doc.characterPrompt.characterForms)).toContain(created.id);
    expect(a.strip.cast.find((c) => c.name === "Store Manager")).toMatchObject({ key: created.id, gender: "male" });
    expect(a.prompts[0]![2]!.startsWith("male, short hair, 1.1::grey hair::, glasses, wrinkled skin")).toBe(true);
    on.pipeline.dispose();

    const off = await setup({ freeCharacters: false });
    const b = await run3(off, manager);
    expect(b.prompt).toContain("Anyone not listed above appears only as an unnamed background person");
    expect(b.prompt).not.toContain("NOT listed above (");
    expect((await off.fx.services.storage.loadCharacterDocument(CHARACTER_ID)).customCharacters).toEqual([]);
    expect(b.strip.cast.map((c) => c.name)).toEqual(["Miyoko", "Shouta"]);
    expect(b.prompts[0]!.length).toBe(2);
    off.pipeline.dispose();
  });
});

const run3 = (s: Awaited<ReturnType<typeof setup>>, manager: unknown) => s.run("m1", board([MIYOKO_LOOK, manager], ["Miyoko", "Shouta", "Store Manager"]));
