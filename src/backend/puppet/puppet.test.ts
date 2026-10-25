import { describe, expect, test } from "bun:test";
import { STORAGE_PATHS, type PuppetState } from "../../shared/contract/index.js";
import { RpcFailure } from "../rpc/errors.js";
import { createFakeServices } from "../testing/fake-services.js";
import { createPuppetService, PUPPET_CONCURRENCY, puppetService } from "./puppet.js";

const RIG_ANSWER = {
  comic: false,
  parts: [
    { label: "torso", character: 0, box_2d: [329, 240, 1000, 756], pivot: [781, 488], attached_to: null },
    { label: "head", character: 0, box_2d: [0, 103, 467, 678], pivot: [447, 381], attached_to: 0 },
    { label: "forearm", character: 0, box_2d: [525, 672, 787, 938], pivot: [721, 712], attached_to: 0, resting: false },
    { label: "item", character: 0, box_2d: [348, 764, 801, 906], pivot: [618, 841], attached_to: 2 },
  ],
};

function fixture() {
  const fx = createFakeServices();
  let clock = 0;
  const service = createPuppetService(fx.services, { now: () => `2026-10-25T00:00:${String(clock++).padStart(2, "0")}.000Z` });
  return { fx, service };
}

describe("puppet service", () => {
  test("rigs an image with one vision call, stores the rig with the image and turns it on", async () => {
    const { fx, service } = fixture();
    fx.llmReplies.push(RIG_ANSWER);
    const state = await service.rig("img-1");
    expect(state).toMatchObject({ imageId: "img-1", status: "ready", enabled: true });
    expect(state.rig!.parts.map((p) => p.label)).toEqual(["torso", "head", "forearm", "item"]);
    expect(state.rig!.model).toBe("fake-model");
    const request = fx.llmRequests[0]!;
    expect(request).toMatchObject({ purpose: "image-puppet", responseMode: "json", visionFallback: "fail" });
    const content = request.messages[1]!.content as Array<{ type: string }>;
    expect(content.map((c) => c.type)).toEqual(["image", "text"]);
    expect(fx.json.get(STORAGE_PATHS.puppet("img-1"))).toEqual(state);
    expect(await service.get(["img-1", "img-2"])).toEqual({ "img-1": state, "img-2": { imageId: "img-2", status: "none", enabled: false, updatedAt: "" } });
  });

  test("reuses a stored rig: turning it off and on again costs no call", async () => {
    const { fx, service } = fixture();
    fx.llmReplies.push(RIG_ANSWER);
    await service.rig("img-1");
    expect((await service.setEnabled("img-1", false)).enabled).toBe(false);
    expect((await service.rig("img-1")).enabled).toBe(true);
    expect(fx.llmRequests).toHaveLength(1);
    fx.llmReplies.push(RIG_ANSWER);
    await service.rig("img-1", { force: true });
    expect(fx.llmRequests).toHaveLength(2);
  });

  test("concurrent requests for one image share the call; calls for different images are capped", async () => {
    const { fx, service } = fixture();
    let running = 0, peak = 0;
    const gates: Array<() => void> = [];
    fx.services.llm.complete = async (request) => {
      fx.llmRequests.push(request);
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return { raw: "", parsed: RIG_ANSWER, connectionId: "c", model: "m", attempts: 1, usage: {}, finishReason: "stop", jsonMode: true, imagesDropped: false, latencyMs: 1 };
    };
    const same = [service.rig("a"), service.rig("a")];
    const others = ["b", "c", "d"].map((id) => service.rig(id));
    for (let i = 0; i < 50 && gates.length < PUPPET_CONCURRENCY; i++) await Bun.sleep(1);
    expect(gates).toHaveLength(PUPPET_CONCURRENCY);
    while (gates.length || fx.llmRequests.length < 4) {
      gates.shift()?.();
      await Bun.sleep(1);
    }
    const [a1, a2] = await Promise.all(same);
    await Promise.all(others);
    expect(a1).toEqual(a2);
    expect(fx.llmRequests).toHaveLength(4);
    expect(peak).toBe(PUPPET_CONCURRENCY);
  });

  test("a model without vision fails without storing anything", async () => {
    const { fx, service } = fixture();
    fx.visionSupported.value = false;
    const error = await service.rig("img-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcFailure);
    expect((error as RpcFailure).error.code).toBe("unsupported");
    expect(fx.llmRequests).toHaveLength(0);
    expect(fx.json.has(STORAGE_PATHS.puppet("img-1"))).toBe(false);
  });

  test("comic pages, empty answers and filtered answers are stored as failed with the reason", async () => {
    const { fx, service } = fixture();
    fx.llmReplies.push({ comic: true, parts: [] }, { comic: false, parts: [] });
    expect((await service.rig("comic")).failure).toEqual({ code: "comic", message: "Comic pages with several panels can't be animated." });
    expect((await service.rig("empty")).failure?.code).toBe("nothing-found");
    fx.llmReplies.push(new RpcFailure({ code: "provider-error", message: "The provider filtered the analyzer response.", detailCode: "ANALYZER_CONTENT_FILTERED" } as never));
    const declined = await service.rig("blocked");
    expect(declined).toMatchObject({ status: "failed", enabled: false, failure: { code: "declined" } });
    // A failed image is asked again on the next click.
    fx.llmReplies.push(RIG_ANSWER);
    expect((await service.rig("empty")).status).toBe("ready");
  });

  test("other errors propagate and leave the image unrigged", async () => {
    const { fx, service } = fixture();
    fx.llmReplies.push(new RpcFailure({ code: "timeout", message: "Analyzer timed out after 180000 ms" } as never));
    await expect(service.rig("img-1")).rejects.toBeInstanceOf(RpcFailure);
    expect((await service.get(["img-1"]))["img-1"]!.status).toBe("none");
  });

  test("setEnabled needs a rig to turn on; get rejects big batches and survives unreadable files", async () => {
    const { fx, service } = fixture();
    await expect(service.setEnabled("img-1", true)).rejects.toBeInstanceOf(RpcFailure);
    expect((await service.setEnabled("img-1", false)).status).toBe("none");
    await expect(service.get(Array.from({ length: 65 }, (_, i) => `id-${i}`))).rejects.toBeInstanceOf(RpcFailure);
    fx.json.set(STORAGE_PATHS.puppet("broken"), { status: "ready", enabled: true } satisfies Partial<PuppetState>);
    expect((await service.get(["broken"])).broken!.status).toBe("none");
  });

  test("puppetService is one instance per user (RPC contexts are fresh objects)", () => {
    const { fx } = fixture();
    expect(puppetService({ ...fx.services })).toBe(puppetService({ ...fx.services }));
    expect(puppetService(createFakeServices().services)).not.toBe(puppetService(fx.services));
  });
});
