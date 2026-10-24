/** Services under concurrent use: caches filled by reads that raced a write, document revisions, RPC failure logging. */
import { describe, expect, test } from "bun:test";
import { createRequest, STORAGE_PATHS } from "../../shared/contract/index.js";
import { CHARACTER_OUTFIT_HISTORY_PATH, createOutfitImageController } from "../analysis/outfit.js";
import { createAnalysisModule } from "../analysis/index.js";
import { fail } from "../rpc/errors.js";
import { allHandlers } from "../rpc/handlers/index.js";
import { createBackendRuntime } from "../runtime.js";
import { createFakeHost } from "../testing/fake-host.js";
import { createSourcesService } from "./sources.js";
import { createStorageService } from "./storage.js";

describe("storage service: concurrent use", () => {
  test("config cache: a loadConfig that read before an updateConfig does not overwrite the cache afterwards", async () => {
    const fake = createFakeHost();
    fake.files.set(STORAGE_PATHS.configModel, JSON.stringify({ version: 1, analysis: { temperature: 0.3 } }));
    const us = fake.host.userStorage as unknown as { read: (path: string, userId?: string) => Promise<string> };
    const realRead = us.read.bind(us);
    let armed = false;
    let release!: () => void;
    // The read snapshots the file immediately; the answer of the armed read is delivered late (slow host IPC).
    us.read = async (path, userId) => {
      const outcome = await realRead(path, userId).then((v) => ({ v }), (e: unknown) => ({ e }));
      if (armed && path === STORAGE_PATHS.configModel) {
        armed = false;
        await new Promise<void>((r) => (release = r));
      }
      if ("e" in outcome) throw outcome.e;
      return outcome.v;
    };
    const storage = createStorageService(fake.host, fake.userId);

    armed = true;
    const reader = storage.loadConfig(); // e.g. session.getStatus / llm.effectiveSettings at startup (cache still empty)
    await new Promise((r) => setTimeout(r, 0));
    await storage.updateConfig((c) => ({ ...c, analysis: { ...c.analysis, temperature: 0.9 } })); // config.update
    release();
    await reader;

    // The update succeeded, so every later read must see it ...
    expect((await storage.loadConfig()).analysis.temperature).toBe(0.9);
    // ... and a later unrelated update must not write the old value back to disk.
    await storage.updateConfig((c) => ({ ...c, analysis: { ...c.analysis, timeoutMs: 60000 } }));
    expect(JSON.parse(fake.files.get(STORAGE_PATHS.configModel) as string).analysis.temperature).toBe(0.9);
  });

  test("missing character document: an edit based on the loaded empty document passes the revision guard", async () => {
    const outcome = (p: Promise<unknown>, ok: string) => p.then(() => ok, (e: { error?: { code?: string; detailCode?: string } }) => `${e?.error?.code}:${e?.error?.detailCode}`);
    const fake = createFakeHost();
    fake.addCharacter({ id: "c1", name: "Hero" });
    const runtime = createBackendRuntime({ host: fake.host, modules: [(services, get) => createAnalysisModule(services, get)] });
    const ctx = runtime.context(fake.userId);
    const handlers = allHandlers() as Record<string, (params: unknown, ctx: unknown) => Promise<any>>;

    // Entry point 1: roster editor (frontend editor.tsx) sends baseUpdatedAt = workspace.load snapshot document.updatedAt.
    const snapshot = await handlers["workspace.load"]!({ characterId: "c1" }, ctx);
    const custom = await outcome(handlers["customCharacters.create"]!({ characterId: "c1", input: { title: "Maid", recognitionKeys: "maid" }, baseUpdatedAt: snapshot.document.updatedAt }, ctx), "created");

    // Entry point 2: outfitImage.save on a character without asset-maid.json (outfit.ts: base = loadCharacterDocument,
    // then updateCharacterDocument(..., { expectedUpdatedAt: base.updatedAt })).
    const characterId = "c2";
    const result = { resultId: "r1", imageId: "img-1", url: "/api/v1/images/img-1", seed: "1", width: 832, height: 1216, positivePrompt: "p", negativePrompt: "", createdAt: new Date().toISOString() };
    fake.files.set(CHARACTER_OUTFIT_HISTORY_PATH(characterId), JSON.stringify({ version: 1, targets: { [`${characterId}|form_default|`]: [result] } }));
    const controller = createOutfitImageController(runtime.services(fake.userId));
    const draft = { label: "School", head: "", top: "shirt", bottom: "", legs: "", feet: "", seed: "", seedFixed: false, useCharacterReference: false };
    const outfit = await outcome(controller.save({ target: { kind: "character", characterId, promptKey: characterId }, formId: "form_default", resultIds: ["r1"], mode: "add", draft }), "saved");

    expect({ custom, outfit }).toEqual({ custom: "created", outfit: "saved" });
  });
});

describe("sources service: cache invalidation", () => {
  test("sources cache: a character read in flight during invalidate() is not cached", async () => {
    const fake = createFakeHost();
    fake.addCharacter({ id: "c1", name: "Old name" });
    const characters = fake.host.characters as unknown as { get: (id: string, userId?: string) => Promise<unknown> };
    const realGet = characters.get.bind(characters);
    let armed = false;
    let release!: () => void;
    characters.get = async (id, userId) => {
      const dto = await realGet(id, userId); // snapshot taken before the edit
      if (armed) {
        armed = false;
        await new Promise<void>((r) => (release = r));
      }
      return dto;
    };
    const sources = createSourcesService({ host: fake.host, userId: fake.userId });

    armed = true;
    const inflight = sources.getCharacter("c1"); // e.g. workspace.load / pipeline buildSource
    await new Promise((r) => setTimeout(r, 0));
    fake.characters.set("c1", { ...fake.characters.get("c1")!, name: "New name" }); // the user edits the character
    sources.invalidate("c1"); // CHARACTER_EDITED handler (backend.ts)
    release();
    await inflight;

    expect((await sources.getCharacter("c1")).name).toBe("New name");
  });
});

describe("rpc wiring", () => {
  test("a failed RPC request is written to the run log once", async () => {
    const fake = createFakeHost();
    const runtime = createBackendRuntime({ host: fake.host, modules: [], handlers: { "logs.list": () => fail("not-found", "missing thing") } });
    await runtime.handleFrontendMessage(createRequest("logs.list", {}, "req-1"), fake.userId);
    const rpcLines = runtime.services(fake.userId).log.list().filter((e) => e.scope === "rpc");
    expect(rpcLines.map((e) => e.message)).toEqual(["logs.list failed: missing thing"]);
  });
});
